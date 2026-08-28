import { parsePlayerdata } from './tutorial-playerdata';

/**
 * Verbatim excerpt of the largest real `playerdata` in the 2026-08-19 baseline
 * (`ops/baseline/2026-08-19/austv-diagnostico-saida.txt`, "AMOSTRA: maior
 * playerdata"). Quest ids changed to tutorial ones, structure untouched.
 *
 * Real payload rather than an invented one, by the same rule that produced the
 * `serverOverview` fixture: story S6.2 was written against an imagined state and
 * had to be reverted.
 */
const REAL_SHAPE = `quest-progress:
  01tutorial:
    started: false
    started-date: 1723333480856
    completed: true
    completed-before: true
    completion-date: 1723383959256
    task-progress:
      objetivo:
        completed: false
  02tutorial:
    started: true
    started-date: 1723383959256
    completed: false
    completed-before: false
    task-progress:
      alimentar:
        completed: false
`;

describe('parsePlayerdata', () => {
  describe('the real payload', () => {
    it('reads both quests with their dates', () => {
      const result = parsePlayerdata(REAL_SHAPE);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.quests).toEqual([
        {
          questId: '01tutorial',
          startedAt: 1723333480856,
          completed: true,
          completedAt: 1723383959256,
        },
        {
          questId: '02tutorial',
          startedAt: 1723383959256,
          completed: false,
          completedAt: null,
        },
      ]);
    });

    it('does not treat `started: false` as "never entered"', () => {
      // The trap in the real payload: `started: false` sits next to
      // `completed: true` on a quest the player demonstrably finished, because
      // the flag tracks *currently in progress*. A parser keying off it would
      // report that almost nobody ever entered the tutorial — a false negative
      // on the exact metric this feature exists to produce.
      const result = parsePlayerdata(REAL_SHAPE);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const first = result.value.quests[0];
      expect(first.questId).toBe('01tutorial');
      expect(first.startedAt).not.toBeNull();
      expect(first.completed).toBe(true);
    });
  });

  describe('files that hold nothing', () => {
    it('reads an empty file as zero quests, not as a failure', () => {
      // 41% of the baseline's 19.700 files were 0 bytes: players who connected
      // and never touched a quest. Failing on the single largest legitimate
      // category would drown the real parse errors.
      const result = parsePlayerdata('');

      expect(result).toEqual({ ok: true, value: { quests: [] } });
    });

    it('reads whitespace and comments as zero quests', () => {
      expect(parsePlayerdata('\n  \n')).toEqual({
        ok: true,
        value: { quests: [] },
      });
      expect(parsePlayerdata('# nada aqui\n')).toEqual({
        ok: true,
        value: { quests: [] },
      });
    });

    it('reads a file with other keys but no quest-progress as zero quests', () => {
      const result = parsePlayerdata('outra-coisa:\n  x: 1\n');

      expect(result).toEqual({ ok: true, value: { quests: [] } });
    });
  });

  describe('a format that changed under us', () => {
    it('fails loudly when quest-progress is not a map', () => {
      // The distinction that matters: an unparseable file and a player with no
      // quests mean opposite things. Collapsing them would let a Quests upgrade
      // read as "nobody enters the tutorial any more" — indistinguishable from
      // the disaster the check is looking for.
      const result = parsePlayerdata('quest-progress:\n  - 01tutorial\n');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('quest-progress');
    });

    it('fails when the root is not a map', () => {
      const result = parsePlayerdata('- apenas\n- uma\n- lista\n');

      expect(result.ok).toBe(false);
    });

    it('fails on invalid YAML rather than returning empty', () => {
      const result = parsePlayerdata('quest-progress:\n  a: [1,\n');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('YAML invalido');
    });

    it('skips one malformed quest without discarding the others', () => {
      const result = parsePlayerdata(
        'quest-progress:\n' +
          '  01tutorial: "nao e um mapa"\n' +
          '  02tutorial:\n' +
          '    started-date: 1723383959256\n' +
          '    completed: true\n',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The file still answers the question for the other forty quests.
      expect(result.value.quests).toHaveLength(1);
      expect(result.value.quests[0].questId).toBe('02tutorial');
    });
  });

  describe('timestamps', () => {
    it('accepts the string spelling of an epoch', () => {
      // YAML quotes long integers under some writer configurations. Trusting
      // only the number spelling would start returning nulls after a plugin
      // update, which reads downstream as "nobody entered".
      const result = parsePlayerdata(
        'quest-progress:\n  01tutorial:\n    started-date: "1723333480856"\n',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quests[0].startedAt).toBe(1723333480856);
    });

    it('rejects zero as a date instead of dating it to 1970', () => {
      // `0` is a finite number and would render as 1970-01-01, inventing a
      // phantom cohort at the head of every series.
      const result = parsePlayerdata(
        'quest-progress:\n  01tutorial:\n    started-date: 0\n',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quests[0].startedAt).toBeNull();
    });

    it.each([['-1'], ['nao-um-numero'], ['true'], ['[]']])(
      'reads %s as an absent date, never as a guess',
      (raw) => {
        const result = parsePlayerdata(
          `quest-progress:\n  01tutorial:\n    started-date: ${raw}\n`,
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.quests[0].startedAt).toBeNull();
      },
    );

    it('keeps the quest when the date is missing, because the key is the entry', () => {
      // Absent date is not "did not start" — the presence of the key is what
      // means started. The consumer drops the row from a daily series for want
      // of a day; it must not conclude the player never entered.
      const result = parsePlayerdata(
        'quest-progress:\n  01tutorial:\n    completed: false\n',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quests).toEqual([
        {
          questId: '01tutorial',
          startedAt: null,
          completed: false,
          completedAt: null,
        },
      ]);
    });
  });

  describe('completion', () => {
    it('treats only an explicit `true` as completed', () => {
      const result = parsePlayerdata(
        'quest-progress:\n' +
          '  01tutorial:\n    completed: false\n' +
          '  02tutorial:\n    completed: "true"\n' +
          '  03tutorial:\n    completed: true\n',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quests.map((q) => q.completed)).toEqual([
        false,
        // The string "true" is not the boolean. Coercing it would be guessing
        // at a format we have not observed.
        false,
        true,
      ]);
    });

    it('ignores `completed-before`, which is not what the funnel asks', () => {
      const result = parsePlayerdata(
        'quest-progress:\n' +
          '  01tutorial:\n    completed: false\n    completed-before: true\n',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.quests[0].completed).toBe(false);
    });
  });
});
