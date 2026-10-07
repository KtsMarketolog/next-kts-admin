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

test('TOP has one admin-gated audience editor immediately after HTML upload, before data upload', () => {
  const matches = editors('../src/features/admin/top-dashboard/AdminTopDashboardSection.tsx');
  assert.equal(matches.length, 1);
  assert.match(matches[0].key, /top:\$\{blockId\}/);
  assert.match(matches[0].previous, /topDashboardUploadCard/);
  assert.match(matches[0].previous, /Выбрать HTML/);
  assert.doesNotMatch(matches[0].container, /<h2>Данные дашборда<\/h2>/);
});

test('personal and route-planner editors follow their own HTML forms without duplicate controls below data', () => {
  const matches = editors('../src/features/admin/manager-dashboard/ManagerDashboardManagement.tsx');
  assert.equal(matches.length, 2);
  assert.match(matches[0].key, /manager:\$\{audience\}/);
  assert.match(matches[0].previous, /^<form/);
  assert.match(matches[0].previous, /uploadHtml\(event, audience\)/);
  assert.match(matches[0].container, /data-dashboard-equal-row="html"/);
  assert.match(matches[1].key, /route-planner/);
  assert.match(matches[1].previous, /^<form/);
  assert.match(matches[1].previous, /uploadSharedHtml\(event\)/);
});
