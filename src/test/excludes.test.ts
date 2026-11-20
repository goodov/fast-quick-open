import * as assert from 'assert';

import { relativePathMatchesGlobs } from '../excludes.ts';

function matches(relativePath: string, pattern: string): boolean {
  return relativePathMatchesGlobs(relativePath, [pattern]);
}

suite('exclude glob matching', () => {
  test('a leading slash anchors the pattern to the search root', () => {
    for (const p of [
      'third_party',
      'third_party/blink',
      'third_party/blink/b.txt',
    ]) {
      assert.strictEqual(matches(p, '/third_party'), true, p);
    }
    for (const p of ['sub/third_party', 'sub/third_party/st.txt']) {
      assert.strictEqual(matches(p, '/third_party'), false, p);
    }
  });

  test('a pattern without a slash matches at any depth', () => {
    for (const pattern of ['third_party', '**/third_party']) {
      for (const p of [
        'third_party',
        'third_party/blink',
        'third_party/blink/b.txt',
        'sub/third_party',
        'sub/third_party/st.txt',
      ]) {
        assert.strictEqual(matches(p, pattern), true, `${p} ~ ${pattern}`);
      }
    }
  });

  test('trailing slash and /** suffix behave like the bare directory', () => {
    for (const pattern of ['/third_party/', '/third_party/**']) {
      assert.strictEqual(matches('third_party/blink', pattern), true, pattern);
      assert.strictEqual(matches('sub/third_party', pattern), false, pattern);
    }
  });

  test('an inner slash anchors the pattern too', () => {
    assert.strictEqual(matches('third_party/blink', 'third_party/blink'), true);
    assert.strictEqual(
      matches('third_party/blink/b.txt', 'third_party/blink'),
      true,
    );
    assert.strictEqual(
      matches('sub/third_party/blink', 'third_party/blink'),
      false,
    );
  });

  test('common exclude patterns keep matching', () => {
    assert.strictEqual(matches('node_modules/x', '**/node_modules'), true);
    assert.strictEqual(matches('a/node_modules/x', '**/node_modules'), true);
    assert.strictEqual(matches('a/b.code-search', '**/*.code-search'), true);
    assert.strictEqual(matches('.git', '**/.git'), true);
    assert.strictEqual(matches('x/.git/HEAD', '**/.git'), true);
    assert.strictEqual(matches('src/extension.ts', '**/node_modules'), false);
  });

  test('a ./ prefix is treated as root-anchored, like fd', () => {
    assert.strictEqual(matches('third_party/blink', './third_party'), true);
    assert.strictEqual(matches('sub/third_party', './third_party'), false);
  });

  test('empty pattern lists and empty patterns match nothing', () => {
    assert.strictEqual(relativePathMatchesGlobs('third_party', []), false);
    assert.strictEqual(matches('third_party', '/'), false);
    assert.strictEqual(matches('third_party', '  '), false);
  });
});
