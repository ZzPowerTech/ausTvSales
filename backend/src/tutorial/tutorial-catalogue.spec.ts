import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTutorialCatalogue } from './tutorial-catalogue';

/**
 * Real directory, not a mocked `fs`.
 *
 * The whole job of this module is reading a directory correctly — extension
 * filtering, name-to-id mapping, and failing when the path is wrong. A mocked
 * `readdir` would assert that the mock returns what the mock was told to return.
 */
async function withCatalogueDir(
  files: string[],
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'austv-tutorial-'));
  try {
    for (const file of files) {
      await writeFile(join(dir, file), 'tasks: {}\n', 'utf8');
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Names taken from the 2026-08-19 baseline, branches included. */
const REAL_NAMES = [
  '01tutorial.yml',
  '02tutorial.yml',
  '04-2tutorial.yml',
  '12-3tutorial.yml',
  '33tutorial.yml',
];

describe('loadTutorialCatalogue', () => {
  it('maps real file names to quest ids, branches included', async () => {
    await withCatalogueDir(REAL_NAMES, async (dir) => {
      const catalogue = await loadTutorialCatalogue(dir, '33tutorial');

      expect([...catalogue.ids].sort()).toEqual([
        '01tutorial',
        '02tutorial',
        '04-2tutorial',
        '12-3tutorial',
        '33tutorial',
      ]);
      // The `-2` / `-3` branches are real steps players take. A hardcoded list
      // written before they existed would silently stop counting them.
      expect(catalogue.has('04-2tutorial')).toBe(true);
      expect(catalogue.has('diario_escavacao')).toBe(false);
    });
  });

  it('ignores files that are not quest definitions', async () => {
    await withCatalogueDir(
      ['01tutorial.yml', 'README.md', 'backup.yml.bak'],
      async (dir) => {
        const catalogue = await loadTutorialCatalogue(dir, '01tutorial');

        expect(catalogue.ids).toEqual(['01tutorial']);
      },
    );
  });

  describe('refuses to produce a plausible zero', () => {
    it('throws when the directory does not exist', async () => {
      // An unreadable path must not degrade to an empty catalogue: with no
      // tutorial ids, every player looks like someone who never entered — which
      // is precisely the reading the seventh check exists to alarm on. A
      // misconfigured path would manufacture the disaster it detects.
      await expect(
        loadTutorialCatalogue(
          join(tmpdir(), 'austv-nao-existe-jamais'),
          '33tutorial',
        ),
      ).rejects.toThrow(/catalogo de quests do tutorial/);
    });

    it('throws when the directory holds no quest file', async () => {
      await withCatalogueDir(['LEIAME.txt'], async (dir) => {
        await expect(loadTutorialCatalogue(dir, '33tutorial')).rejects.toThrow(
          /nenhum arquivo/,
        );
      });
    });

    it('throws when the configured final quest is not in the catalogue', async () => {
      // Without this, completion would be counted against a quest nobody can
      // hold, and the funnel would publish a permanent 0% completion — a
      // believable number and a false one.
      await withCatalogueDir(REAL_NAMES, async (dir) => {
        await expect(loadTutorialCatalogue(dir, '99tutorial')).rejects.toThrow(
          /99tutorial/,
        );
      });
    });
  });
});
