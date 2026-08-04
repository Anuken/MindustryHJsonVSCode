import * as fs from 'fs';
import * as path from 'path';
import { parseMHJson } from '../parser/mhjsonParser';

const dir = process.argv[2];
if (!dir) {
	console.error('Usage: parserSmokeTest <dir-of-hjson-files> [maxFiles]');
	process.exit(1);
}
const max = process.argv[3] ? parseInt(process.argv[3], 10) : Infinity;

function collect(d: string, out: string[]) {
	for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
		const full = path.join(d, entry.name);
		if (entry.isDirectory()) collect(full, out);
		else if (entry.name.endsWith('.hjson')) out.push(full);
	}
}

const files: string[] = [];
collect(dir, files);
files.sort();

let ok = 0, fail = 0;
const failures: { file: string; message: string }[] = [];

for (const file of files.slice(0, max)) {
	const text = fs.readFileSync(file, 'utf8');
	const result = parseMHJson(text);
	if (result.root && result.errors.length === 0) {
		ok++;
	} else {
		fail++;
		const msg = result.errors.map((e) => e.message).join('; ') || '(no root parsed)';
		failures.push({ file, message: msg });
	}
}

console.log(`Parsed ${ok}/${ok + fail} files without errors.`);
if (failures.length) {
	console.log('\nFailures:');
	for (const f of failures.slice(0, 40)) {
		console.log(`  ${f.file}\n    -> ${f.message}`);
	}
	if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
}
