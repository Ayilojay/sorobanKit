import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.resolve(dashboardRoot, '../docs/openapi.json');
const outputPath = path.resolve(dashboardRoot, 'src/api/generated/openapi.ts');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const generated = astToString(await openapiTS(contract));

if (process.argv.includes('--check')) {
  let existing;
  try {
    existing = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing !== generated) {
    throw new Error('Generated API types are out of date. Run npm run api:generate.');
  }
  console.log('Generated API types match docs/openapi.json.');
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated);
  console.log('Generated API types from docs/openapi.json.');
}
