#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const targetVersion = process.argv[2]?.trim().replace(/^v/, '');

if (!targetVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetVersion)) {
  console.error('Usage: node scripts/bump-version.js <semver-version>');
  console.error('Example: node scripts/bump-version.js 0.4.0');
  process.exit(1);
}

console.log(`Bumping FerryCat version to v${targetVersion}...`);

// 1. package.json
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
pkg.version = targetVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`✓ Updated package.json (${oldVersion} -> ${targetVersion})`);

// 2. server.json
const serverJsonPath = path.join(rootDir, 'server.json');
if (fs.existsSync(serverJsonPath)) {
  const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
  serverJson.version = targetVersion;
  if (Array.isArray(serverJson.packages)) {
    for (const p of serverJson.packages) {
      p.version = targetVersion;
    }
  }
  fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n', 'utf8');
  console.log(`✓ Updated server.json (${targetVersion})`);
}

// 3. src/index.ts
const indexPath = path.join(rootDir, 'src', 'index.ts');
if (fs.existsSync(indexPath)) {
  let content = fs.readFileSync(indexPath, 'utf8');
  content = content.replace(/return pkg\.version \?\? '[^']+';/g, `return pkg.version ?? '${targetVersion}';`);
  content = content.replace(/return '[^']+';\s*}\s*const PKG_VERSION/g, `return '${targetVersion}';\n  }\n}\n\nconst PKG_VERSION`);
  fs.writeFileSync(indexPath, content, 'utf8');
  console.log(`✓ Updated fallback version in src/index.ts`);
}

// 4. test/run-all.ts
const testPath = path.join(rootDir, 'test', 'run-all.ts');
if (fs.existsSync(testPath)) {
  let testContent = fs.readFileSync(testPath, 'utf8');
  testContent = testContent.replace(/FerryCat CLI v\d+\.\d+\.\d+/g, `FerryCat CLI v${targetVersion}`);
  testContent = testContent.replace(/assert\.strictEqual\(verRes\.stdout\.trim\(\), '\d+\.\d+\.\d+'\);/g, `assert.strictEqual(verRes.stdout.trim(), '${targetVersion}');`);
  fs.writeFileSync(testPath, testContent, 'utf8');
  console.log(`✓ Synchronized version check assertions in test/run-all.ts`);
}

console.log(`\n🎉 Successfully bumped all files to v${targetVersion}!`);
console.log(`Next steps:`);
console.log(`  1. npm run build && npm test`);
console.log(`  2. git commit -am "release: v${targetVersion}"`);
console.log(`  3. git tag v${targetVersion} && git push origin main --tags`);
