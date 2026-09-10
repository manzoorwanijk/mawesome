/**
 * Regenerates the inputs, outputs and workflow sections of this action's README and of the library's `docs/action.md`.
 * Run with `pnpm readme`; `--check` fails when either file is stale, for CI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const actionDir = join(here, '..');
const docsDir = join(actionDir, '..', '..', 'packages', 'pr-baseline', 'docs');

type Marker = 'inputs' | 'outputs' | 'workflow';

/** Every file carrying generated blocks: the mirror's README and the documentation page. */
const TARGETS: { file: string; markers: Marker[] }[] = [
	{ file: join(actionDir, 'README.md'), markers: ['inputs', 'outputs', 'workflow'] },
	{ file: join(docsDir, 'action.md'), markers: ['workflow', 'inputs', 'outputs'] },
];

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

function render(text: string, marker: Marker, body: string, file: string): string {
	const start = `<!-- ${marker}:start -->`;
	const end = `<!-- ${marker}:end -->`;
	const from = text.indexOf(start);
	const to = text.indexOf(end);
	if (from === -1 || to === -1 || to < from) {
		throw new Error(`${relative(actionDir, file)} is missing the ${marker} markers.`);
	}
	// A blank line on each side is what the formatter leaves around a block, so the result is stable under it.
	return `${text.slice(0, from + start.length)}\n\n${body}\n\n${text.slice(to)}`;
}

export function generate(): { file: string; current: string; next: string }[] {
	const action = parseAction(readFileSync(join(actionDir, 'action.yml'), 'utf8'));
	const workflow = readFileSync(join(actionDir, 'workflow-template.yml'), 'utf8').trimEnd();
	const blocks: Record<Marker, string> = {
		inputs: table([
			['Input', 'Description', 'Default'],
			...[...action.inputs]
				.filter(([name]) => name !== 'github-token-probe')
				.map(([name, input]) => [
					`\`${name}\``,
					cell(input.description),
					input.default === undefined ? '' : `\`${input.default}\``,
				]),
		]),
		outputs: table([
			['Output', 'Description'],
			...[...action.outputs].map(([name, description]) => [`\`${name}\``, cell(description)]),
		]),
		workflow: `\`\`\`yaml\n${workflow}\n\`\`\``,
	};
	return TARGETS.map(({ file, markers }) => {
		const current = readFileSync(file, 'utf8');
		let next = current;
		for (const marker of markers) {
			next = render(next, marker, blocks[marker], file);
		}
		return { file, current, next };
	});
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
	const stale = generate().filter(({ current, next }) => current !== next);
	const names = stale.map(({ file }) => relative(actionDir, file)).join(', ');
	if (values.check) {
		if (stale.length > 0) {
			console.error(`${names} stale; run \`pnpm readme\`.`);
			process.exit(1);
		}
		console.log('the generated action docs are current.');
	} else if (stale.length > 0) {
		for (const { file, next } of stale) {
			writeFileSync(file, next);
		}
		console.log(`updated ${names}.`);
	}
}
