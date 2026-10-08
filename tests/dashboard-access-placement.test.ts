import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function editors(file: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DashboardAudienceEditor') matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches.map((editor) => {
    const conditional = editor.parent;
    assert.ok(ts.isConditionalExpression(conditional));
    assert.equal(conditional.condition.getText(source), 'canAssignAccess');
    const expression = conditional.parent;
    assert.ok(ts.isJsxExpression(expression));
    const container = expression.parent;
    assert.ok(ts.isJsxElement(container));
    const siblings = container.children.filter((child) => !ts.isJsxText(child) || child.text.trim());
    const previous = siblings[siblings.indexOf(expression) - 1];
    assert.ok(previous && ts.isJsxElement(previous));
    for (let ancestor: ts.Node | undefined = editor.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isJsxElement(ancestor)) assert.notEqual(ancestor.openingElement.tagName.getText(source), 'form', 'Access controls must not submit an HTML or data upload form');
    }
    return {previous: previous.getText(source), key: editor.attributes.getText(source), container: container.getText(source)};
  });
}

test('TOP follows report, data, HTML and publication, access, then histories in DOM order', () => {
  const matches = editors('../src/features/admin/top-dashboard/AdminTopDashboardSection.tsx');
  assert.equal(matches.length, 1);
  assert.match(matches[0].key, /top:\$\{blockId\}/);
  assert.match(matches[0].previous, /id="top-dashboard-html-upload"/);
  assert.match(matches[0].previous, /topDashboardUploadCard/);
  assert.match(matches[0].previous, /Выбрать HTML/);
  assert.match(matches[0].previous, /Опубликовать черновик/);
  const source = matches[0].container;
  const sequence = ['ref={previewCardRef}', 'id="top-dashboard-data-upload"', 'id="top-dashboard-html-upload"', '<DashboardAudienceEditor', 'id="top-dashboard-data-history"', 'id="top-dashboard-html-history"'];
  const positions = sequence.map((marker) => source.indexOf(marker));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
});

test('personal editors keep their placement and refresh recipients while route-planner follows data and HTML publication', () => {
  const matches = editors('../src/features/admin/manager-dashboard/ManagerDashboardManagement.tsx');
  assert.equal(matches.length, 2);
  assert.match(matches[0].key, /manager:\$\{audience\}/);
  assert.match(matches[0].previous, /^<form/);
  assert.match(matches[0].previous, /uploadHtml\(event, audience\)/);
  assert.match(matches[0].container, /data-dashboard-equal-row="html"/);
  assert.match(matches[0].key, /onSaved=\{onReload\}/);
  assert.match(matches[1].key, /route-planner/);
  assert.match(matches[1].previous, /^<section/);
  assert.match(matches[1].previous, /id="manager-dashboard-shared-html-upload"/);
  assert.match(matches[1].previous, /uploadSharedHtml\(event\)/);
  assert.match(matches[1].previous, /Опубликовать общий HTML/);
  const source = matches[1].container;
  assert.ok(source.indexOf('id="manager-dashboard-shared-data-upload"') < source.indexOf('id="manager-dashboard-shared-html-upload"'));
  assert.ok(source.indexOf('id="manager-dashboard-shared-html-upload"') < source.indexOf('<DashboardAudienceEditor'));
});
