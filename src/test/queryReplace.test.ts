import * as assert from 'assert';

import { compileQueryReplaceRules } from '../helpers/queryReplace.ts';

function apply(input: unknown, query: string): string {
  return compileQueryReplaceRules(input).replacer.apply(query);
}

suite('queryReplace', () => {
  test('no rules is a no-op', () => {
    assert.strictEqual(apply(undefined, 'src/a.ts'), 'src/a.ts');
    assert.strictEqual(apply([], 'src/a.ts'), 'src/a.ts');
  });

  test('applies a single rule', () => {
    const rules = [{ find: '^gh ', replace: '.github/workflows/' }];
    assert.strictEqual(apply(rules, 'gh build'), '.github/workflows/build');
  });

  test('rules chain in declared order', () => {
    const rules = [
      { find: '^a', replace: 'b' },
      { find: '^b', replace: 'c' },
    ];
    assert.strictEqual(apply(rules, 'ax'), 'cx');
  });

  test('supports capture groups in the replacement', () => {
    const rules = [{ find: '^(\\w+)!$', replace: 'src/$1.ts' }];
    assert.strictEqual(apply(rules, 'config!'), 'src/config.ts');
  });

  test('replaces first match without flags and all with g', () => {
    assert.strictEqual(apply([{ find: 'a', replace: 'b' }], 'aaa'), 'baa');
    assert.strictEqual(
      apply([{ find: 'a', replace: 'b', flags: 'g' }], 'aaa'),
      'bbb',
    );
  });

  test('reuses a global rule across calls', () => {
    const { replacer } = compileQueryReplaceRules([
      { find: 'a', replace: 'b', flags: 'g' },
    ]);
    assert.strictEqual(replacer.apply('aaa'), 'bbb');
    assert.strictEqual(replacer.apply('aaa'), 'bbb');
  });

  test('skips an invalid regex but keeps later rules', () => {
    const { replacer, errors } = compileQueryReplaceRules([
      { find: '([', replace: 'x' },
      { find: '^a', replace: 'b' },
    ]);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(replacer.apply('ax'), 'bx');
  });

  test('skips malformed entries', () => {
    const { replacer, errors } = compileQueryReplaceRules([
      'nope',
      null,
      {},
      { find: '' },
      { find: 'a', replace: 1 },
      { find: 'a', flags: 'q' },
      { find: 'a', flags: 7 },
    ]);
    assert.strictEqual(errors.length, 7);
    assert.strictEqual(replacer.apply('aaa'), 'aaa');
  });

  test('missing replace deletes the match', () => {
    assert.strictEqual(apply([{ find: '^x ' }], 'x foo'), 'foo');
  });

  test('rejects a non-array config', () => {
    const { replacer, errors } = compileQueryReplaceRules({ a: 'b' });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(replacer.apply('a'), 'a');
  });

  test('stops runaway expansion', () => {
    const rules = [{ find: 'a', replace: 'a'.repeat(2000), flags: 'g' }];
    assert.strictEqual(apply(rules, 'a'), 'a');
  });
});

suite('queryReplace groups', () => {
  const groups = [
    [
      { find: '^gh ', replace: '.github/' },
      { find: '$', replace: '.yml' },
    ],
    [
      { find: '^t ', replace: 'src/test/' },
      { find: '$', replace: '.test.ts' },
    ],
  ];

  test('runs the first group whose leading rule matches', () => {
    assert.strictEqual(apply(groups, 'gh build'), '.github/build.yml');
  });

  test('skips groups whose leading rule does not match', () => {
    assert.strictEqual(apply(groups, 't picker'), 'src/test/picker.test.ts');
  });

  test('leaves the query alone when no group matches', () => {
    assert.strictEqual(apply(groups, 'src/a.ts'), 'src/a.ts');
  });

  test('only the first matching group runs', () => {
    const overlapping = [
      [{ find: '^a', replace: 'one' }],
      [{ find: '^a', replace: 'two' }],
    ];
    assert.strictEqual(apply(overlapping, 'ax'), 'onex');
  });

  test('a gate with the g flag is not left mid-string', () => {
    const gated = [[{ find: 'a', replace: 'b', flags: 'g' }]];
    assert.strictEqual(apply(gated, 'aaa'), 'bbb');
    assert.strictEqual(apply(gated, 'aaa'), 'bbb');
  });

  test('runs unconditional rules before the first matching group', () => {
    const { replacer, errors } = compileQueryReplaceRules([
      { find: '^(?:\\.\\./){2}', replace: '' },
      [
        { find: '^gh ', replace: '.github/' },
        { find: '$', replace: '.yml' },
      ],
      [{ find: '^t ', replace: 'src/test/' }],
    ]);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(replacer.apply('../../gh build'), '.github/build.yml');
  });

  test('runs unconditional rules after the first matching group', () => {
    const { replacer, errors } = compileQueryReplaceRules([
      [{ find: '^a', replace: 'one' }],
      { find: '$', replace: '!' },
      [{ find: '^one', replace: 'two' }],
    ]);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(replacer.apply('ax'), 'onex!');
  });

  test('drops a group with no valid rules', () => {
    const { replacer, errors } = compileQueryReplaceRules([
      [{ find: '([' }],
      [{ find: '^a', replace: 'b' }],
    ]);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(replacer.apply('ax'), 'bx');
  });
});
