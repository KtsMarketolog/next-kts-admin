import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

/** Inspect actual JSX sibling structure, not a text match that could pass inside a header/comment. */
function placement(component: string) {
  const file = `../src/features/admin/${component}.tsx`;
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DashboardInstructions') matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(matches.length, 1, `${component} has one help placement, without an earlier duplicate`);
  const help = matches[0];
  let child: ts.Node = help;
  while (child.parent && !ts.isJsxElement(child.parent)) child = child.parent;
  const container = child.parent;
  assert.ok(container && ts.isJsxElement(container), 'help belongs to a JSX container');
  const siblings = container.children.filter((node) => !ts.isJsxText(node) || node.text.trim());
  const index = siblings.indexOf(child as ts.JsxChild);
  assert.ok(index >= 0);
  return { source, help, container, child, siblings, index, previous: siblings[index - 1], next: siblings[index + 1] };
}

test('personal MR/MS viewer places help after the full report and before data history', () => {
  const result = placement('manager-dashboard/ManagerDashboardViewer');
  assert.ok(ts.isJsxSelfClosingElement(result.previous));
  assert.equal(result.previous.tagName.getText(result.source), 'PersonalDashboardViewer');
  assert.ok(ts.isJsxSelfClosingElement(result.next));
  assert.equal(result.next.tagName.getText(result.source), 'DashboardDataHistory');
  assert.match(result.help.attributes.getText(result.source), /dashboardKey=\{`manager:\$\{overview\.audience\}`\}/);
});

test('TOP personal MR review places help after the selected report, never before its selector', () => {
  const result = placement('manager-dashboard/ManagerDashboardReview');
  assert.ok(ts.isJsxExpression(result.previous));
  assert.match(result.previous.getText(result.source), /^\{selected \? <ReviewReport\b/);
  assert.equal(result.container.openingElement.tagName.getText(result.source), 'main');
  assert.match(result.help.attributes.getText(result.source), /dashboardKey="manager:development"/);
  assert.equal(result.next, undefined);
});

test('personal management keeps main panels and preview ahead of audience-scoped help, with histories following', () => {
  const result = placement('manager-dashboard/ManagerDashboardManagement');
  assert.ok(ts.isJsxExpression(result.child));
  assert.match(result.child.getText(result.source), /^\{personalOverview \?/);
  assert.match(result.child.getText(result.source), /groups\.filter\(\(group\) => !audience \|\| group\.audience === audience\)\.map/);
  assert.match(result.help.attributes.getText(result.source), /dashboardKey=\{`manager:\$\{group\.audience\}`\}/);
  assert.match(result.previous.getText(result.source), /uploadSnapshots\(event\)/);
  assert.ok(ts.isJsxElement(result.next));
  assert.match(result.next.openingElement.attributes.getText(result.source), /id="manager-dashboard-html-history"/);
  const previousSiblings = result.siblings.slice(0, result.index).map((node) => node.getText(result.source));
  assert.ok(previousSiblings.some((text) => text.includes('id="manager-dashboard-html-preview"') && text.includes('<DashboardFrame')));
  assert.ok(previousSiblings.some((text) => text.includes('id={`manager-dashboard-files-${audience}`}')));
  assert.ok(result.siblings.slice(result.index + 1).some((node) => node.getText(result.source).includes('<ManagerDashboardImportJournal')));
});

for (const component of ['TopDashboardViewer', 'AdminTopDashboardSection']) {
  test(`${component} puts sales help after and outside the fullscreen report card`, () => {
    const result = placement(`top-dashboard/${component}`);
    assert.ok(ts.isJsxElement(result.previous));
    assert.equal(result.previous.openingElement.tagName.getText(result.source), 'section');
    assert.match(result.previous.openingElement.attributes.getText(result.source), /ref=\{previewCardRef\}/);
    assert.match(result.previous.getText(result.source), /<iframe\b/);
    assert.doesNotMatch(result.previous.getText(result.source), /<DashboardInstructions\b/);
    assert.match(result.child.getText(result.source), /overview\?\.instruction === 'sales-analytics'/);
    assert.match(result.help.attributes.getText(result.source), /dashboardKey=\{`top:\$\{blockId\}`\}/);
    if (component === 'AdminTopDashboardSection') {
      assert.ok(ts.isJsxElement(result.next));
      assert.match(result.next.openingElement.attributes.getText(result.source), /id="top-dashboard-data-upload"/);
    } else {
      assert.equal(result.next, undefined);
    }
  });
}
