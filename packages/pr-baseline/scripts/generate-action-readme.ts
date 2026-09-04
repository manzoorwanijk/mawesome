/**
 * Regenerates the inputs, outputs and workflow sections of `action/README.md` from `action.yml` and the template.
 * Run with `pnpm readme:action`; `--check` fails when the README is stale, for CI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const actionDir = join(here, '..', 'action');

interface Input {
	description: string;
	required?: boolean;
	default?: string;
}

/** The subset of action.yml this script needs, read with a small line parser to avoid a YAML dependency. */
function parseAction(text: string): { inputs: Map<string, Input>; outputs: Map<string, string> } {
	const inputs = new Map<string, Input>();
	const outputs = new Map<string, string>();
	let section: 'inputs' | 'outputs' | null = null;
	let current: string | null = null;
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\s+$/, '');
		if (line.startsWith('inputs:')) {
			section = 'inputs';
			continue;
		}
		if (line.startsWith('outputs:')) {
			section = 'outputs';
			continue;
		}
		if (/^\S/.test(line)) {
			section = null;
			continue;
		}
		if (section === null) {
			continue;
		}
		const name = /^  ([\w-]+):\s*$/.exec(line);
		if (name !== null) {
			current = name[1] as string;
			if (section === 'inputs') {
				inputs.set(current, { description: '' });
			} else {
				outputs.set(current, '');
			}
			continue;
		}
		const field = /^    (description|required|default):\s*(.*)$/.exec(line);
		if (field === null || current === null) {
			continue;
		}
		const value = unquote(field[2] as string);
		if (section === 'outputs') {
			if (field[1] === 'description') {
				outputs.set(current, value);
			}
			continue;
		}
		const input = inputs.get(current) as Input;
		if (field[1] === 'description') {
			input.description = value;
		} else if (field[1] === 'required') {
			input.required = value === 'true';
		} else {
			input.default = value;
		}
	}
	return { inputs, outputs };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function cell(text: string): string {
	return text.replaceAll('|', '\\|');
}

/** Renders rows as the formatter would: every column padded to its widest cell, the separator dashed to match. */
function table(rows: string[][]): string {
	const widths = (rows[0] as string[]).map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? '').length)),
	);
	const line = (row: string[]): string =>
		`| ${row.map((text, column) => text.padEnd(widths[column] as number)).join(' | ')} |`;
	const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
	return [line(rows[0] as string[]), separator, ...rows.slice(1).map(line)].join('\n');
}

function render(readme: string, marker: string, body: string): string {
	const start = `<!-- ${marker}:start -->`;
	const end = `<!-- ${marker}:end -->`;
	const from = readme.indexOf(start);
	const to = readme.indexOf(end);
	if (from === -1 || to === -1 || to < from) {
		throw new Error(`README is missing the ${marker} markers.`);
	}
	// A blank line on each side is what the formatter leaves around a block, so the result is stable under it.
	return `${readme.slice(0, from + start.length)}\n\n${body}\n\n${readme.slice(to)}`;
}

export function generate(): { current: string; next: string } {
	const action = parseAction(readFileSync(join(actionDir, 'action.yml'), 'utf8'));
	const workflow = readFileSync(join(actionDir, 'workflow-template.yml'), 'utf8').trimEnd();
	const current = readFileSync(join(actionDir, 'README.md'), 'utf8');
	const inputs = table([
		['Input', 'Description', 'Default'],
		...[...action.inputs]
			.filter(([name]) => name !== 'github-token-probe')
			.map(([name, input]) => [
				`\`${name}\``,
				cell(input.description),
				input.default === undefined ? '' : `\`${input.default}\``,
			]),
	]);
	const outputs = table([
		['Output', 'Description'],
		...[...action.outputs].map(([name, description]) => [`\`${name}\``, cell(description)]),
	]);
	let next = render(current, 'inputs', inputs);
	next = render(next, 'outputs', outputs);
	next = render(next, 'workflow', `\`\`\`yaml\n${workflow}\n\`\`\``);
	return { current, next };
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
	const { current, next } = generate();
	if (values.check) {
		if (current !== next) {
			console.error('action/README.md is stale; run `pnpm readme:action`.');
			process.exit(1);
		}
		console.log('action/README.md is current.');
	} else if (current !== next) {
		writeFileSync(join(actionDir, 'README.md'), next);
		console.log('action/README.md updated.');
	}
}
