const fs = require('node:fs')
const path = require('node:path')

// This repo keeps source imports extensionless; native ESM needs .js at runtime, so append it
// to relative specifiers in the compiled output. Same purpose as the indexer's fix-imports step.
const DIST = path.resolve(__dirname, '..', 'dist')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const SPEC = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+?)\2/g

function resolvedSpecifier(fileDir, spec) {
  if (/\.[cm]?js$/.test(spec)) return spec // already extensioned
  const target = path.resolve(fileDir, spec)
  if (fs.existsSync(`${target}.js`)) return `${spec}.js`
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return `${spec}/index.js`
  return `${spec}.js`
}

let changed = 0
for (const file of walk(DIST)) {
  const dir = path.dirname(file)
  const src = fs.readFileSync(file, 'utf8')
  const next = src.replace(SPEC, (_m, lead, quote, spec) => `${lead}${quote}${resolvedSpecifier(dir, spec)}${quote}`)
  if (next !== src) {
    fs.writeFileSync(file, next)
    changed++
  }
}
console.log(`fix-imports: rewrote ${changed} file(s)`)
