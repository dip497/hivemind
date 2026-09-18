import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = 'src/content/docs/guide';
const origin = (process.env.SITE_URL || 'https://hivemind.griiken.com').replace(/\/$/, '');
const base = (process.env.SITE_BASE ?? '/hivemind').replace(/\/$/, '');
const url = `${origin}${base}`;
const files = (await readdir(root)).filter((file) => file.endsWith('.md')).sort();
const entries = [];
await mkdir('dist/markdown', { recursive: true });
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`Missing frontmatter: ${file}`);
  const title = match[1].match(/^title: (.+)$/m)?.[1];
  const description = match[1].match(/^description: (.+)$/m)?.[1];
  if (!title || !description) throw new Error(`Missing title or description: ${file}`);
  const slug = file.slice(0, -3);
  const page = `${url}/guide/${slug === 'index' ? '' : `${slug}/`}`;
  // Resolve the published guide's links before exporting Markdown elsewhere.
  const body = source.slice(match[0].length).replace(/\]\(([^)\s]+)\)/g, (all, href) => {
    if (/^(?:[a-z]+:|#)/i.test(href)) return all;
    return `](${new URL(href, page).href})`;
  });
  const text = `# ${title}\n\nSource: ${page}\n\n${body.trim()}\n`;
  await writeFile(`dist/markdown/${file}`, text);
  entries.push({ title, description, file, text });
}
const preamble = '# Hivemind\n\n> A workspace for coding agents, on Linux and macOS. Local repositories, terminals, editors, and diffs.\n\nThese docs follow the development branch. Views, the view SDK, and settings commands are development previews. Check installed CLI help before using a command.\n\n';
await writeFile('dist/llms.txt', preamble + '## Documentation\n\n' + entries.map((e) => `- [${e.title}](${url}/markdown/${e.file}): ${e.description}`).join('\n') + '\n');
await writeFile('dist/llms-full.txt', preamble + entries.map((e) => e.text).join('\n---\n\n'));
console.log(`Exported ${entries.length} Markdown guides and agent indexes.`);
