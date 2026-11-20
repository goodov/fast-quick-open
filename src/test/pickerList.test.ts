import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import { REMOVE_FROM_HISTORY_BUTTON } from '../helpers/filePathToQuickPickItem.ts';
import { parseResource } from '../helpers/parseResource.ts';
import PickerList, {
  activeItemIndex,
  itemAtIndex,
  itemKey,
  pickerItemsEqual,
  pickRestoredItem,
  quickPickItemKey,
} from '../helpers/pickerList.ts';

function uriItem(filePath: string, recent = false): vscode.QuickPickItem {
  return {
    label: path.basename(filePath),
    resourceUri: parseResource(filePath),
    buttons: recent ? [REMOVE_FROM_HISTORY_BUTTON] : undefined,
  };
}

suite('pickerItemsEqual', () => {
  const a = uriItem('/ws/a.ts');
  const b = uriItem('/ws/b.ts');

  test('true when keys and button state match', () => {
    assert.ok(
      pickerItemsEqual([a, b], [uriItem('/ws/a.ts'), uriItem('/ws/b.ts')]),
    );
  });

  test('false when order or membership changes', () => {
    assert.ok(!pickerItemsEqual([a, b], [b, a]));
    assert.ok(!pickerItemsEqual([a, b], [a]));
  });

  test('false when only the history button changes', () => {
    assert.ok(!pickerItemsEqual([a], [uriItem('/ws/a.ts', true)]));
  });
});

suite('active index capture / restore', () => {
  const a = uriItem('/ws/a.ts');
  const b = uriItem('/ws/b.ts');
  const c = uriItem('/ws/c.ts');

  test('captures the active row', () => {
    assert.strictEqual(activeItemIndex([a, b, c], b), 1);
    assert.strictEqual(activeItemIndex([a, b, c], a), 0);
    assert.strictEqual(activeItemIndex([a, b, c], b), 1);
  });

  test('no capture when active is missing', () => {
    assert.strictEqual(activeItemIndex([a, b], undefined), undefined);
    assert.strictEqual(activeItemIndex([a], c), undefined);
  });

  test('restores the saved row even if the widget already jumped to first', () => {
    assert.strictEqual(itemAtIndex([a, b, c], 1), b);
    assert.notStrictEqual(itemAtIndex([a, b, c], 1), a);
  });

  test('restores the same row after the list grows', () => {
    const grown = [a, b, c, uriItem('/ws/d.ts')];
    assert.strictEqual(itemAtIndex(grown, 1), b);
  });

  test('clamps when the list shrinks past the saved index', () => {
    assert.strictEqual(itemAtIndex([a], 2), a);
  });

  test('no restore when the new list is empty', () => {
    assert.strictEqual(itemAtIndex([], 1), undefined);
    assert.strictEqual(itemAtIndex([a, b], undefined), undefined);
  });

  test('quickPickItemKey is stable for the same file URI', () => {
    assert.strictEqual(
      quickPickItemKey(a),
      quickPickItemKey(uriItem('/ws/a.ts')),
    );
  });
});

suite('pickRestoredItem', () => {
  const a = uriItem('/ws/a.ts');
  const b = uriItem('/ws/b.ts');
  const c = uriItem('/ws/c.ts');

  test('follows the same item when it moves', () => {
    assert.strictEqual(pickRestoredItem([c, b, a], itemKey(b), 1), b);
  });

  test('uses the saved index when the item is gone', () => {
    const x = uriItem('/ws/x.ts');
    const y = uriItem('/ws/y.ts');
    const z = uriItem('/ws/z.ts');
    assert.strictEqual(pickRestoredItem([x, y, z], itemKey(b), 2), z);
  });

  test('clamps the index when the list shrinks', () => {
    assert.strictEqual(pickRestoredItem([a], itemKey(c), 2), a);
  });

  test('no restore when the new list is empty', () => {
    assert.strictEqual(pickRestoredItem([], itemKey(b), 1), undefined);
  });

  test('stays on the first row when nothing was followed', () => {
    assert.strictEqual(pickRestoredItem([c, a, b], undefined, 0), c);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function twoFiles(): {
  a: vscode.QuickPickItem;
  b: vscode.QuickPickItem;
} {
  return {
    a: { label: 'aaa.ts', alwaysShow: true, description: 'dir-a' },
    b: { label: 'aab.ts', alwaysShow: true, description: 'dir-b' },
  };
}

function activeLabel(qp: vscode.QuickPick<vscode.QuickPickItem>): string {
  return qp.activeItems[0]?.label ?? '<none>';
}

suite('QuickPick active item (real widget)', function () {
  this.timeout(8000);

  const pickers: vscode.QuickPick<vscode.QuickPickItem>[] = [];

  function createPicker(): vscode.QuickPick<vscode.QuickPickItem> {
    const qp = vscode.window.createQuickPick();
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    pickers.push(qp);
    return qp;
  }

  teardown(() => {
    while (pickers.length > 0) {
      pickers.pop()?.dispose();
    }
  });

  test('can highlight the second item', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    qp.items = [a, b];
    qp.show();
    qp.activeItems = [b];
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aab.ts');
  });

  test('setting value resets the highlight to the first item', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    qp.items = [a, b];
    qp.show();
    qp.activeItems = [b];
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aab.ts');

    qp.value = 'aa';
    await delay(500);
    assert.strictEqual(
      activeLabel(qp),
      'aaa.ts',
      'VS Code trySelectFirst after value change',
    );
  });

  test('replacing items resets the highlight to the first item', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    qp.items = [a, b];
    qp.show();
    qp.activeItems = [b];
    await delay(50);

    const a2 = { ...a };
    const b2 = { ...b };
    qp.items = [a2, b2];
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'aaa.ts');
  });
});

suite('PickerList (real widget)', function () {
  this.timeout(8000);

  const pickers: vscode.QuickPick<vscode.QuickPickItem>[] = [];

  function createPicker(): vscode.QuickPick<vscode.QuickPickItem> {
    const qp = vscode.window.createQuickPick();
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    pickers.push(qp);
    return qp;
  }

  teardown(() => {
    while (pickers.length > 0) {
      pickers.pop()?.dispose();
    }
  });

  test('lets a keystroke reset the highlight to the first row', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    const list = new PickerList(qp);
    list.setItems([a, b]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);

    qp.value = 'aa';
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'aaa.ts');
  });

  test('after a keystroke, a later items replace stays on the first row', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    const list = new PickerList(qp);
    list.setItems([a, b]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);

    qp.value = 'aa';
    await delay(50);
    list.setItems([
      { label: 'aaa.ts', alwaysShow: true, description: 'dir-a' },
      { label: 'aab.ts', alwaysShow: true, description: 'dir-b' },
    ]);
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'aaa.ts');
  });

  test('keeps the second row after items are replaced with the same files', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    const list = new PickerList(qp);
    list.setItems([a, b]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);

    list.setItems([
      { label: 'aaa.ts', alwaysShow: true, description: 'dir-a' },
      { label: 'aab.ts', alwaysShow: true, description: 'dir-b' },
    ]);
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'aab.ts');
  });

  test('after idle, moving back to the first row is kept', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    const list = new PickerList(qp);
    list.setItems([a, b]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);

    qp.activeItems = [qp.items[0]!];
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aaa.ts');
  });

  test('stays on first when a recent floats above the default highlight', async () => {
    const qp = createPicker();
    const list = new PickerList(qp);
    list.setItems([uriItem('/ws/aaa.ts'), uriItem('/ws/aab.ts', true)]);
    qp.show();
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aaa.ts');

    list.setItems([uriItem('/ws/aab.ts', true), uriItem('/ws/aaa.ts')]);
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'aab.ts');
  });

  test('follows the same file when it moves to another row', async () => {
    const qp = createPicker();
    const a = uriItem('/ws/aaa.ts');
    const b = uriItem('/ws/aab.ts');
    const c = uriItem('/ws/aac.ts');
    const list = new PickerList(qp);
    list.setItems([a, b, c]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);

    list.setItems([
      uriItem('/ws/aac.ts'),
      uriItem('/ws/aaa.ts'),
      uriItem('/ws/aab.ts'),
    ]);
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'aab.ts');
  });

  test('keeps the same index when the file is gone', async () => {
    const qp = createPicker();
    const list = new PickerList(qp);
    list.setItems([
      uriItem('/ws/aaa.ts'),
      uriItem('/ws/aab.ts'),
      uriItem('/ws/aac.ts'),
    ]);
    qp.show();
    qp.activeItems = [qp.items[2]!];
    await delay(50);

    list.setItems([
      uriItem('/ws/xxx.ts'),
      uriItem('/ws/yyy.ts'),
      uriItem('/ws/zzz.ts'),
    ]);
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'zzz.ts');
  });

  test('after a list replace, a later move to another row is kept', async () => {
    const qp = createPicker();
    const { a, b } = twoFiles();
    const c = { label: 'aac.ts', alwaysShow: true, description: 'dir-c' };
    const list = new PickerList(qp);
    list.setItems([a, b, c]);
    qp.show();
    qp.activeItems = [c];
    await delay(50);

    list.setItems([
      { label: 'aaa.ts', alwaysShow: true, description: 'dir-a' },
      { label: 'aab.ts', alwaysShow: true, description: 'dir-b' },
      { label: 'aac.ts', alwaysShow: true, description: 'dir-c' },
    ]);
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aac.ts');

    qp.activeItems = [qp.items[1]!];
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aab.ts');
  });

  test('reset forgets a pinned row so the next list starts at the first item', async () => {
    const qp = createPicker();
    const a = uriItem('/ws/aaa.ts');
    const b = uriItem('/ws/aab.ts');
    const list = new PickerList(qp);
    list.setItems([a, b]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aab.ts');

    list.reset();
    list.setItems([uriItem('/ws/xxx.ts'), uriItem('/ws/yyy.ts')]);
    await delay(500);
    assert.strictEqual(activeLabel(qp), 'xxx.ts');
  });

  test('setItems({ force }) always assigns items and activates the first', async () => {
    const qp = createPicker();
    const list = new PickerList(qp);
    const a = uriItem('/ws/aaa.ts');
    const b = uriItem('/ws/aab.ts');
    list.setItems([a, b]);
    qp.show();
    qp.activeItems = [b];
    await delay(50);
    assert.strictEqual(activeLabel(qp), 'aab.ts');

    list.setItems([a, b], { force: true });
    await delay(50);
    assert.strictEqual(qp.items[0], a);
    assert.strictEqual(qp.items[1], b);
    assert.strictEqual(activeLabel(qp), 'aaa.ts');
  });
});
