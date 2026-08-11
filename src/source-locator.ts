import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

const CONFIGURATION_FILE_SUFFIXES = ['.tf.json', '.tofu.json', '.tf', '.tofu'] as const

export interface TerraformComponentReference {
  address: string
  sourceAddress?: string
}

export interface SourceLocation {
  path: string
  startLine: number
}

export type SourceMappingReason =
  | 'invalid_address'
  | 'ambiguous_declaration'
  | 'missing_declaration'
  | 'unsafe_module_source'
  | 'unsupported_module_source'
  | 'unreadable_configuration'

export type SourceMapping =
  | { kind: 'found'; location: SourceLocation }
  | { kind: 'unresolved'; reason: SourceMappingReason }

export interface TerraformSourceLocatorOptions {
  workspaceRoot: string
  terraformRoot: string
}

interface ParsedAddress {
  modules: readonly ModuleAddressStep[]
  resource: ResourceAddressStep
}

interface ModuleAddressStep {
  name: string
}

interface ResourceAddressStep {
  type: string
  name: string
}

interface Declaration {
  kind: 'resource' | 'module'
  resourceType?: string
  name: string
  source: ModuleSource
  line: number
}

type ModuleSource = { kind: 'local'; value: string } | { kind: 'external' } | { kind: 'unknown' }

interface ParsedConfiguration {
  declarations: readonly Declaration[]
  reliable: boolean
}

interface ResourceDeclaration {
  location: SourceLocation
}

interface ModuleDeclaration {
  location: SourceLocation
  source: ModuleSource
}

interface ModuleIndex {
  reliable: boolean
  resources: ReadonlyMap<string, readonly ResourceDeclaration[]>
  modules: ReadonlyMap<string, readonly ModuleDeclaration[]>
}

interface HclToken {
  kind: 'identifier' | 'string' | 'open-brace' | 'close-brace' | 'equals' | 'other'
  text: string
  line: number
}

interface JsonValue {
  kind: 'object' | 'array' | 'string' | 'literal'
  line: number
  properties?: readonly JsonProperty[]
  stringValue?: string
}

interface JsonProperty {
  key: string
  line: number
  value: JsonValue
}

interface JsonToken {
  kind: 'string' | 'open-object' | 'close-object' | 'open-array' | 'close-array' | 'colon' | 'comma' | 'literal'
  text: string
  line: number
}

/**
 * Resolves Terraform addresses to locations in the checked-out repository.
 * It intentionally returns no location when it cannot establish an exact match.
 */
export class TerraformSourceLocator {
  private readonly indices = new Map<string, Promise<ModuleIndex>>()
  private readonly workspaceRoot: string
  private readonly terraformRoot: string

  private constructor(workspaceRoot: string, terraformRoot: string) {
    this.workspaceRoot = workspaceRoot
    this.terraformRoot = terraformRoot
  }

  static async create(options: TerraformSourceLocatorOptions): Promise<TerraformSourceLocator> {
    const workspaceRoot = await resolveRootDirectory(options.workspaceRoot)
    const terraformRoot = await resolveSafeDirectory(workspaceRoot, path.resolve(workspaceRoot, options.terraformRoot))
    if (terraformRoot === undefined) {
      throw new Error('terraform-root must be an existing directory inside the repository')
    }

    return new TerraformSourceLocator(workspaceRoot, terraformRoot)
  }

  async locate(reference: TerraformComponentReference): Promise<SourceMapping> {
    const targetAddress = reference.sourceAddress ?? reference.address
    const address = parseTerraformAddress(targetAddress)
    if (address === undefined) {
      return unresolved('invalid_address')
    }

    let currentDirectory = this.terraformRoot
    const visitedDirectories = new Set<string>([currentDirectory])

    for (const moduleStep of address.modules) {
      const index = await this.getModuleIndex(currentDirectory)
      if (!index.reliable) {
        return unresolved('unreadable_configuration')
      }

      const declarations = index.modules.get(moduleStep.name) ?? []
      if (declarations.length > 1) {
        return unresolved('ambiguous_declaration')
      }
      const declaration = declarations[0]
      if (declaration === undefined) {
        return unresolved('missing_declaration')
      }

      if (declaration.source.kind === 'external') {
        return { kind: 'found', location: declaration.location }
      }
      if (declaration.source.kind === 'unknown') {
        return unresolved('unsupported_module_source')
      }

      const localDirectory = await resolveSafeDirectory(
        this.workspaceRoot,
        path.resolve(currentDirectory, declaration.source.value),
      )
      if (localDirectory === undefined || visitedDirectories.has(localDirectory)) {
        return unresolved('unsafe_module_source')
      }

      visitedDirectories.add(localDirectory)
      currentDirectory = localDirectory
    }

    const index = await this.getModuleIndex(currentDirectory)
    if (!index.reliable) {
      return unresolved('unreadable_configuration')
    }

    const declarations = index.resources.get(resourceKey(address.resource.type, address.resource.name)) ?? []
    if (declarations.length > 1) {
      return unresolved('ambiguous_declaration')
    }
    const declaration = declarations[0]
    return declaration === undefined ? unresolved('missing_declaration') : { kind: 'found', location: declaration.location }
  }

  private getModuleIndex(directory: string): Promise<ModuleIndex> {
    const existing = this.indices.get(directory)
    if (existing !== undefined) {
      return existing
    }

    const created = this.buildModuleIndex(directory)
    this.indices.set(directory, created)
    return created
  }

  private async buildModuleIndex(directory: string): Promise<ModuleIndex> {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      if (entries.some((entry) => configurationFileKind(entry.name) !== undefined && (!entry.isFile() || entry.isSymbolicLink()))) {
        return emptyUnreliableIndex()
      }
      const files = entries
        .filter((entry) => entry.isFile() && configurationFileKind(entry.name) !== undefined)
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))

      const resources = new Map<string, ResourceDeclaration[]>()
      const modules = new Map<string, ModuleDeclaration[]>()

      for (const fileName of files) {
        const filePath = path.join(directory, fileName)
        if (!(await isSafeFile(this.workspaceRoot, filePath))) {
          return emptyUnreliableIndex()
        }

        const file = await readFile(filePath, 'utf8')
        const parsed = configurationFileKind(fileName) === 'json' ? parseJsonConfiguration(file) : parseHclConfiguration(file)
        if (!parsed.reliable) {
          return emptyUnreliableIndex()
        }

        const annotationPath = toAnnotationPath(this.workspaceRoot, filePath)
        if (annotationPath === undefined) {
          return emptyUnreliableIndex()
        }

        for (const declaration of parsed.declarations) {
          if (declaration.kind === 'resource') {
            if (declaration.resourceType === undefined) {
              return emptyUnreliableIndex()
            }
            append(resources, resourceKey(declaration.resourceType, declaration.name), {
              location: { path: annotationPath, startLine: declaration.line },
            })
          } else {
            append(modules, declaration.name, {
              location: { path: annotationPath, startLine: declaration.line },
              source: declaration.source,
            })
          }
        }
      }

      return { reliable: true, resources, modules }
    } catch {
      return emptyUnreliableIndex()
    }
  }
}

function unresolved(reason: SourceMappingReason): SourceMapping {
  return { kind: 'unresolved', reason }
}

function resourceKey(type: string, name: string): string {
  return `${type}\u0000${name}`
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key)
  if (values === undefined) {
    map.set(key, [value])
  } else {
    values.push(value)
  }
}

function emptyUnreliableIndex(): ModuleIndex {
  return { reliable: false, resources: new Map(), modules: new Map() }
}

function configurationFileKind(fileName: string): 'hcl' | 'json' | undefined {
  for (const suffix of CONFIGURATION_FILE_SUFFIXES) {
    if (fileName.endsWith(suffix)) {
      return suffix.endsWith('.json') ? 'json' : 'hcl'
    }
  }
  return undefined
}

function parseTerraformAddress(value: string): ParsedAddress | undefined {
  let position = 0
  const modules: ModuleAddressStep[] = []

  while (readIdentifier(value, position) === 'module') {
    position += 'module'.length
    if (value[position] !== '.') {
      return undefined
    }
    position += 1
    const name = readIdentifier(value, position)
    if (name === undefined) {
      return undefined
    }
    position += name.length
    const moduleIndex = readInstanceIndex(value, position)
    if (moduleIndex === undefined) {
      return undefined
    }
    position = moduleIndex
    if (value[position] !== '.') {
      return undefined
    }
    position += 1
    modules.push({ name })
  }

  const type = readIdentifier(value, position)
  if (type === undefined) {
    return undefined
  }
  position += type.length
  if (value[position] !== '.') {
    return undefined
  }
  position += 1
  const name = readIdentifier(value, position)
  if (name === undefined) {
    return undefined
  }
  position += name.length
  const resourceIndex = readInstanceIndex(value, position)
  if (resourceIndex === undefined || resourceIndex !== value.length) {
    return undefined
  }

  return { modules, resource: { type, name } }
}

function readIdentifier(value: string, start: number): string | undefined {
  if (!isIdentifierStart(value[start])) {
    return undefined
  }

  let end = start + 1
  while (isIdentifierCharacter(value[end])) {
    end += 1
  }
  return value.slice(start, end)
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || character === '_')
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return isIdentifierStart(character) || (character !== undefined && character >= '0' && character <= '9') || character === '-'
}

function readInstanceIndex(value: string, start: number): number | undefined {
  if (value[start] !== '[') {
    return start
  }

  let position = start + 1
  if (value[position] === '"') {
    const closingQuote = readJsonStringEnd(value, position)
    if (closingQuote === undefined || value[closingQuote] !== ']') {
      return undefined
    }
    try {
      JSON.parse(value.slice(position, closingQuote))
    } catch {
      return undefined
    }
    return closingQuote + 1
  }

  const numberStart = position
  let character = value[position]
  while (character !== undefined && character >= '0' && character <= '9') {
    position += 1
    character = value[position]
  }
  if (position === numberStart || value[position] !== ']') {
    return undefined
  }
  return position + 1
}

function readJsonStringEnd(value: string, openingQuote: number): number | undefined {
  let position = openingQuote + 1
  while (position < value.length) {
    const character = value[position]
    if (character === '\\') {
      position += 2
      continue
    }
    if (character === '"') {
      return position + 1
    }
    if (character === '\n' || character === '\r') {
      return undefined
    }
    position += 1
  }
  return undefined
}

function parseHclConfiguration(text: string): ParsedConfiguration {
  const tokens = tokenizeHcl(text)
  if (tokens === undefined) {
    return { declarations: [], reliable: false }
  }

  const declarations: Declaration[] = []
  let position = 0
  let depth = 0

  while (position < tokens.length) {
    const token = tokens[position]
    if (token === undefined) {
      return { declarations: [], reliable: false }
    }

    if (depth === 0 && token.kind === 'identifier' && (token.text === 'resource' || token.text === 'module')) {
      const block = parseHclBlock(tokens, position, token.text)
      if (block === undefined) {
        position += 1
        continue
      }
      declarations.push(block.declaration)
      position = block.nextPosition
      continue
    }

    if (token.kind === 'open-brace') {
      depth += 1
    } else if (token.kind === 'close-brace') {
      depth -= 1
      if (depth < 0) {
        return { declarations: [], reliable: false }
      }
    }
    position += 1
  }

  return depth === 0 ? { declarations, reliable: true } : { declarations: [], reliable: false }
}

function parseHclBlock(
  tokens: readonly HclToken[],
  start: number,
  kind: 'resource' | 'module',
): { declaration: Declaration; nextPosition: number } | undefined {
  const firstLabel = tokens[start + 1]
  const secondLabel = kind === 'resource' ? tokens[start + 2] : undefined
  const openingBrace = tokens[start + (kind === 'resource' ? 3 : 2)]

  if (
    firstLabel?.kind !== 'string' ||
    (kind === 'resource' && secondLabel?.kind !== 'string') ||
    openingBrace?.kind !== 'open-brace'
  ) {
    return undefined
  }

  const closingBrace = findMatchingBrace(tokens, start + (kind === 'resource' ? 3 : 2))
  if (closingBrace === undefined) {
    return undefined
  }

  const source = kind === 'module' ? findHclModuleSource(tokens, start + 3, closingBrace) : { kind: 'unknown' as const }
  const declaration: Declaration =
    kind === 'resource'
      ? {
          kind,
          resourceType: firstLabel.text,
          name: secondLabel?.text ?? '',
          source,
          line: tokens[start]?.line ?? 1,
        }
      : {
          kind,
          name: firstLabel.text,
          source,
          line: tokens[start]?.line ?? 1,
        }

  return { declaration, nextPosition: closingBrace + 1 }
}

function findMatchingBrace(tokens: readonly HclToken[], openingBrace: number): number | undefined {
  let depth = 0
  for (let position = openingBrace; position < tokens.length; position += 1) {
    const token = tokens[position]
    if (token?.kind === 'open-brace') {
      depth += 1
    } else if (token?.kind === 'close-brace') {
      depth -= 1
      if (depth === 0) {
        return position
      }
    }
  }
  return undefined
}

function findHclModuleSource(tokens: readonly HclToken[], start: number, end: number): ModuleSource {
  let depth = 0
  let source: ModuleSource | undefined

  for (let position = start; position < end; position += 1) {
    const token = tokens[position]
    if (token === undefined) {
      return { kind: 'unknown' }
    }
    if (token.kind === 'open-brace') {
      depth += 1
      continue
    }
    if (token.kind === 'close-brace') {
      depth -= 1
      continue
    }
    if (depth !== 0 || token.kind !== 'identifier' || token.text !== 'source') {
      continue
    }

    const equals = tokens[position + 1]
    const value = tokens[position + 2]
    if (equals?.kind !== 'equals' || value?.kind !== 'string' || source !== undefined) {
      return { kind: 'unknown' }
    }
    source = moduleSourceFromLiteral(value.text)
    position += 2
  }

  return source ?? { kind: 'unknown' }
}

function tokenizeHcl(text: string): HclToken[] | undefined {
  const tokens: HclToken[] = []
  let position = 0
  let line = 1

  const advance = (): string | undefined => {
    const character = text[position]
    if (character === undefined) {
      return undefined
    }
    position += 1
    if (character === '\n') {
      line += 1
    }
    return character
  }

  while (position < text.length) {
    const character = text[position]
    if (character === undefined) {
      break
    }
    if (isWhitespace(character)) {
      advance()
      continue
    }
    if (character === '#' || (character === '/' && text[position + 1] === '/')) {
      while (position < text.length && advance() !== '\n') {
        // Consume one complete line comment.
      }
      continue
    }
    if (character === '/' && text[position + 1] === '*') {
      advance()
      advance()
      let closed = false
      while (position < text.length) {
        const commentCharacter = advance()
        if (commentCharacter === '*' && text[position] === '/') {
          advance()
          closed = true
          break
        }
      }
      if (!closed) {
        return undefined
      }
      continue
    }
    if (character === '<' && text[position + 1] === '<') {
      const heredoc = skipHeredoc(text, position, line)
      if (heredoc !== undefined) {
        position = heredoc.position
        line = heredoc.line
        continue
      }
    }
    if (character === '"') {
      const string = readHclString(text, position, line)
      if (string === undefined) {
        return undefined
      }
      tokens.push({ kind: 'string', text: string.value, line })
      position = string.position
      line = string.line
      continue
    }
    if (character === '{') {
      tokens.push({ kind: 'open-brace', text: character, line })
      advance()
      continue
    }
    if (character === '}') {
      tokens.push({ kind: 'close-brace', text: character, line })
      advance()
      continue
    }
    if (character === '=') {
      tokens.push({ kind: 'equals', text: character, line })
      advance()
      continue
    }
    if (isHclIdentifierCharacter(character)) {
      const start = position
      while (isHclIdentifierCharacter(text[position])) {
        advance()
      }
      tokens.push({ kind: 'identifier', text: text.slice(start, position), line })
      continue
    }

    tokens.push({ kind: 'other', text: character, line })
    advance()
  }

  return tokens
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n'
}

function isHclIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && (isIdentifierCharacter(character) || character === '.')
}

function readHclString(text: string, start: number, initialLine: number): { value: string; position: number; line: number } | undefined {
  let position = start + 1
  let line = initialLine
  let value = ''
  while (position < text.length) {
    const character = text[position]
    if (character === undefined || character === '\n' || character === '\r') {
      return undefined
    }
    if (character === '\\') {
      const escaped = text[position + 1]
      if (escaped === undefined) {
        return undefined
      }
      value += `\\${escaped}`
      position += 2
      continue
    }
    if (character === '"') {
      return { value, position: position + 1, line }
    }
    value += character
    position += 1
  }
  return undefined
}

function skipHeredoc(text: string, start: number, initialLine: number): { position: number; line: number } | undefined {
  let position = start + 2
  let allowIndent = false
  if (text[position] === '-') {
    allowIndent = true
    position += 1
  }
  const delimiterStart = position
  while (isIdentifierCharacter(text[position])) {
    position += 1
  }
  if (position === delimiterStart) {
    return undefined
  }
  const delimiter = text.slice(delimiterStart, position)
  while (position < text.length && text[position] !== '\n') {
    position += 1
  }
  if (text[position] !== '\n') {
    return undefined
  }
  position += 1
  let line = initialLine + 1

  while (position <= text.length) {
    const lineStart = position
    while (position < text.length && text[position] !== '\n') {
      position += 1
    }
    const rawLine = text.slice(lineStart, position).endsWith('\r')
      ? text.slice(lineStart, position - 1)
      : text.slice(lineStart, position)
    const comparable = allowIndent ? rawLine.trimStart() : rawLine
    if (comparable === delimiter) {
      return { position: position < text.length ? position + 1 : position, line: position < text.length ? line + 1 : line }
    }
    if (position >= text.length) {
      return undefined
    }
    position += 1
    line += 1
  }
  return undefined
}

function parseJsonConfiguration(text: string): ParsedConfiguration {
  const tokens = tokenizeJson(text)
  if (tokens === undefined) {
    return { declarations: [], reliable: false }
  }

  try {
    const parser = new JsonParser(tokens)
    const root = parser.parseDocument()
    if (root.kind !== 'object') {
      return { declarations: [], reliable: false }
    }

    const declarations: Declaration[] = []
    for (const property of root.properties ?? []) {
      if (property.key === 'resource') {
        collectJsonResources(property.value, declarations)
      } else if (property.key === 'module') {
        collectJsonModules(property.value, declarations)
      }
    }
    return { declarations, reliable: true }
  } catch {
    return { declarations: [], reliable: false }
  }
}

function collectJsonResources(value: JsonValue, declarations: Declaration[]): void {
  if (value.kind !== 'object') {
    return
  }
  for (const typeProperty of value.properties ?? []) {
    if (typeProperty.value.kind !== 'object') {
      continue
    }
    for (const nameProperty of typeProperty.value.properties ?? []) {
      declarations.push({
        kind: 'resource',
        resourceType: typeProperty.key,
        name: nameProperty.key,
        source: { kind: 'unknown' },
        line: nameProperty.line,
      })
    }
  }
}

function collectJsonModules(value: JsonValue, declarations: Declaration[]): void {
  if (value.kind !== 'object') {
    return
  }
  for (const moduleProperty of value.properties ?? []) {
    const sourceProperties = (moduleProperty.value.properties ?? []).filter((property) => property.key === 'source')
    const source =
      sourceProperties.length === 1 && sourceProperties[0]?.value.kind === 'string'
        ? moduleSourceFromLiteral(sourceProperties[0].value.stringValue ?? '')
        : { kind: 'unknown' as const }
    declarations.push({ kind: 'module', name: moduleProperty.key, source, line: moduleProperty.line })
  }
}

function moduleSourceFromLiteral(value: string): ModuleSource {
  if (value.includes('${') || value.includes('%{') || value.includes('\\')) {
    return { kind: 'unknown' }
  }
  if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../')) {
    return { kind: 'local', value }
  }
  if (path.isAbsolute(value)) {
    return { kind: 'unknown' }
  }
  return { kind: 'external' }
}

function tokenizeJson(text: string): JsonToken[] | undefined {
  const tokens: JsonToken[] = []
  let position = 0
  let line = 1

  while (position < text.length) {
    const character = text[position]
    if (character === undefined) {
      break
    }
    if (isWhitespace(character)) {
      if (character === '\n') {
        line += 1
      }
      position += 1
      continue
    }
    const punctuation = jsonPunctuation(character)
    if (punctuation !== undefined) {
      tokens.push({ kind: punctuation, text: character, line })
      position += 1
      continue
    }
    if (character === '"') {
      const end = readJsonStringEnd(text, position)
      if (end === undefined) {
        return undefined
      }
      const raw = text.slice(position, end)
      try {
        const decoded = JSON.parse(raw)
        if (typeof decoded !== 'string') {
          return undefined
        }
        tokens.push({ kind: 'string', text: decoded, line })
      } catch {
        return undefined
      }
      position = end
      continue
    }

    const start = position
    while (position < text.length && !isWhitespace(text[position] ?? '') && jsonPunctuation(text[position] ?? '') === undefined) {
      position += 1
    }
    const literal = text.slice(start, position)
    try {
      const parsed = JSON.parse(literal)
      if (typeof parsed === 'object' && parsed !== null) {
        return undefined
      }
    } catch {
      return undefined
    }
    tokens.push({ kind: 'literal', text: literal, line })
  }

  return tokens
}

function jsonPunctuation(character: string): JsonToken['kind'] | undefined {
  switch (character) {
    case '{':
      return 'open-object'
    case '}':
      return 'close-object'
    case '[':
      return 'open-array'
    case ']':
      return 'close-array'
    case ':':
      return 'colon'
    case ',':
      return 'comma'
    default:
      return undefined
  }
}

class JsonParser {
  private position = 0
  private readonly tokens: readonly JsonToken[]

  constructor(tokens: readonly JsonToken[]) {
    this.tokens = tokens
  }

  parseDocument(): JsonValue {
    const value = this.parseValue()
    if (this.peek() !== undefined) {
      throw new Error('Unexpected JSON token')
    }
    return value
  }

  private parseValue(): JsonValue {
    const token = this.take()
    if (token === undefined) {
      throw new Error('Missing JSON value')
    }
    if (token.kind === 'open-object') {
      return this.parseObject(token.line)
    }
    if (token.kind === 'open-array') {
      return this.parseArray(token.line)
    }
    if (token.kind === 'string') {
      return { kind: 'string', line: token.line, stringValue: token.text }
    }
    if (token.kind === 'literal') {
      return { kind: 'literal', line: token.line }
    }
    throw new Error('Expected JSON value')
  }

  private parseObject(line: number): JsonValue {
    const properties: JsonProperty[] = []
    if (this.consume('close-object')) {
      return { kind: 'object', line, properties }
    }
    while (true) {
      const key = this.take()
      if (key?.kind !== 'string') {
        throw new Error('Expected JSON object key')
      }
      this.expect('colon')
      properties.push({ key: key.text, line: key.line, value: this.parseValue() })
      if (this.consume('close-object')) {
        return { kind: 'object', line, properties }
      }
      this.expect('comma')
    }
  }

  private parseArray(line: number): JsonValue {
    if (this.consume('close-array')) {
      return { kind: 'array', line }
    }
    while (true) {
      this.parseValue()
      if (this.consume('close-array')) {
        return { kind: 'array', line }
      }
      this.expect('comma')
    }
  }

  private expect(kind: JsonToken['kind']): void {
    if (!this.consume(kind)) {
      throw new Error('Unexpected JSON token')
    }
  }

  private consume(kind: JsonToken['kind']): boolean {
    if (this.peek()?.kind !== kind) {
      return false
    }
    this.position += 1
    return true
  }

  private take(): JsonToken | undefined {
    const token = this.tokens[this.position]
    if (token !== undefined) {
      this.position += 1
    }
    return token
  }

  private peek(): JsonToken | undefined {
    return this.tokens[this.position]
  }
}

async function resolveRootDirectory(value: string): Promise<string> {
  const absolute = path.resolve(value)
  const metadata = await lstat(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('workspace-root must be a real directory')
  }
  return await realpath(absolute)
}

async function resolveSafeDirectory(workspaceRoot: string, candidate: string): Promise<string | undefined> {
  if (!isWithin(workspaceRoot, candidate) || containsTerraformDirectory(workspaceRoot, candidate) || (await containsSymbolicLink(workspaceRoot, candidate))) {
    return undefined
  }
  try {
    const metadata = await lstat(candidate)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return undefined
    }
    const resolved = await realpath(candidate)
    return isWithin(workspaceRoot, resolved) && !containsTerraformDirectory(workspaceRoot, resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

async function isSafeFile(workspaceRoot: string, candidate: string): Promise<boolean> {
  if (!isWithin(workspaceRoot, candidate) || containsTerraformDirectory(workspaceRoot, candidate) || (await containsSymbolicLink(workspaceRoot, candidate))) {
    return false
  }
  try {
    const metadata = await lstat(candidate)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return false
    }
    const resolved = await realpath(candidate)
    return isWithin(workspaceRoot, resolved) && !containsTerraformDirectory(workspaceRoot, resolved)
  } catch {
    return false
  }
}

async function containsSymbolicLink(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return relative !== ''
  }
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true
      }
    } catch {
      return false
    }
  }
  return false
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function containsTerraformDirectory(root: string, candidate: string): boolean {
  if (!isWithin(root, candidate)) {
    return true
  }
  return path.relative(root, candidate).split(path.sep).some((segment) => segment === '.terraform')
}

function toAnnotationPath(workspaceRoot: string, filePath: string): string | undefined {
  if (!isWithin(workspaceRoot, filePath) || containsTerraformDirectory(workspaceRoot, filePath)) {
    return undefined
  }
  const relative = path.relative(workspaceRoot, filePath)
  return relative === '' ? undefined : relative.split(path.sep).join('/')
}
