import { parseJSON } from '../parse';
import { Tree } from '../tree'; // Assuming Tree is exported from tree.ts
import { type Node } from '../node'; // Assuming Node is exported from node.ts

describe('Tree.findNodeByPath', () => {
  const createTree = (jsonString: string): Tree | undefined => {
    const { treeObject } = parseJSON(jsonString, { kind: 'main' });
    if (treeObject) {
      return Tree.fromObject(treeObject);
    }
    return undefined;
  };

  test('should find node in simple flat object', () => {
    const tree = createTree('{"key": "value"}');
    const node = tree?.findNodeByPath('key');
    expect(node).toBeDefined();
    expect(node?.value).toBe('value');
    expect(node?.type).toBe('string');
  });

  test('should find nodes in nested object', () => {
    const tree = createTree('{"a": {"b": {"c": "d"}}}');
    const nodeA = tree?.findNodeByPath('a');
    expect(nodeA).toBeDefined();
    expect(nodeA?.type).toBe('object');

    const nodeB = tree?.findNodeByPath('a.b');
    expect(nodeB).toBeDefined();
    expect(nodeB?.type).toBe('object');

    const nodeC = tree?.findNodeByPath('a.b.c');
    expect(nodeC).toBeDefined();
    expect(nodeC?.value).toBe('d');
    expect(nodeC?.type).toBe('string');
  });

  test('should find nodes in array', () => {
    const tree = createTree('{"arr": [10, {"id": "item2"}]}');
    const nodeArr = tree?.findNodeByPath('arr');
    expect(nodeArr).toBeDefined();
    expect(nodeArr?.type).toBe('array');
    
    const node0 = tree?.findNodeByPath('arr[0]');
    expect(node0).toBeDefined();
    expect(node0?.value).toBe(10);
    expect(node0?.type).toBe('number');

    const node1 = tree?.findNodeByPath('arr[1]');
    expect(node1).toBeDefined();
    expect(node1?.type).toBe('object');

    const nodeId = tree?.findNodeByPath('arr[1].id');
    expect(nodeId).toBeDefined();
    expect(nodeId?.value).toBe('item2');
    expect(nodeId?.type).toBe('string');
  });

  test('should handle root paths', () => {
    const tree = createTree('{"key": "value"}');
    // Assuming "" or "$" refers to the root node itself
    const rootNodeEmpty = tree?.findNodeByPath('');
    expect(rootNodeEmpty).toBeDefined();
    expect(rootNodeEmpty?.type).toBe('object');
    expect(rootNodeEmpty?.id).toBe('root');


    const rootNodeDollar = tree?.findNodeByPath('$');
    expect(rootNodeDollar).toBeDefined();
    expect(rootNodeDollar?.type).toBe('object');
    expect(rootNodeDollar?.id).toBe('root');

    const valueNode = tree?.findNodeByPath('$.key');
     expect(valueNode).toBeDefined();
     expect(valueNode?.value).toBe('value');
  });

  test('should return undefined for invalid paths', () => {
    const tree = createTree('{"a": {"b": "c"}, "arr": [1, 2]}');
    expect(tree?.findNodeByPath('nonexistent')).toBeUndefined();
    expect(tree?.findNodeByPath('a.nonexistent')).toBeUndefined();
    expect(tree?.findNodeByPath('arr[5]')).toBeUndefined(); // out of bounds
    expect(tree?.findNodeByPath('a.b.c.d')).toBeUndefined(); // too deep
    expect(tree?.findNodeByPath('arr.key')).toBeUndefined(); // key on array
    expect(tree?.findNodeByPath('a[0]')).toBeUndefined(); // index on object
  });

  test('should find nodes of different value types', () => {
    const json = `{
      "s": "string",
      "n": 123,
      "b": true,
      "nil": null,
      "o": {"k": "v"},
      "ar": [1, "t"]
    }`;
    const tree = createTree(json);

    const sNode = tree?.findNodeByPath('s');
    expect(sNode?.value).toBe('string');
    expect(sNode?.type).toBe('string');

    const nNode = tree?.findNodeByPath('n');
    expect(nNode?.value).toBe(123);
    expect(nNode?.type).toBe('number');

    const bNode = tree?.findNodeByPath('b');
    expect(bNode?.value).toBe(true);
    expect(bNode?.type).toBe('boolean');
    
    const nilNode = tree?.findNodeByPath('nil');
    expect(nilNode?.value).toBeNull();
    expect(nilNode?.type).toBe('null');

    const oNode = tree?.findNodeByPath('o');
    expect(oNode?.type).toBe('object');

    const arNode = tree?.findNodeByPath('ar');
    expect(arNode?.type).toBe('array');
  });

  test('should find nodes in complex nested structure', () => {
    const json = `{
      "level1": {
        "item1": "value1",
        "level2array": [
          "str_in_arr",
          {
            "id": "obj_in_arr",
            "level3obj": {
              "deepKey": 100,
              "deepNull": null
            }
          }
        ],
        "level2bool": false
      }
    }`;
    const tree = createTree(json);

    expect(tree?.findNodeByPath('level1.item1')?.value).toBe('value1');
    expect(tree?.findNodeByPath('level1.level2array[0]')?.value).toBe('str_in_arr');
    expect(tree?.findNodeByPath('level1.level2array[1].id')?.value).toBe('obj_in_arr');
    expect(tree?.findNodeByPath('level1.level2array[1].level3obj.deepKey')?.value).toBe(100);
    expect(tree?.findNodeByPath('level1.level2array[1].level3obj.deepNull')?.type).toBe('null');
    expect(tree?.findNodeByPath('level1.level2bool')?.value).toBe(false);
  });

   test('should return undefined for path on non-object/array', () => {
    const tree = createTree('{"key": "value"}');
    expect(tree?.findNodeByPath('key.subKey')).toBeUndefined();
  });

  test('should handle paths with special characters if jsonc.parsePath supports them', () => {
    // This depends on jsonc.parsePath's behavior.
    // Assuming keys like "a.b" are treated as single segments by findNodeByPath
    // if jsonc.parsePath returns them as such.
    // The current findNodeByPath implementation iterates segments from jsonc.parsePath.
    const tree = createTree('{"a.b": "dot-value", "c[0]": "bracket-value"}');
    
    let node = tree?.findNodeByPath('a.b'); // This would be 'a' then 'b' if not escaped.
                                          // If jsonc.parsePath returns "a.b" as one segment, it should work.
                                          // Our current implementation of findNodeByPath does not support this.
                                          // It will look for 'a' then 'b'.
                                          // Let's assume jsonPath needs to be "escaped" for such keys.
                                          // e.g. '["a.b"]'
    
    // To test "a.b" as a single key, the path string needs to tell jsonc.parsePath to treat it as one.
    // Typically, this is done by quoting: '["a.b"]'
    node = tree?.findNodeByPath('["a.b"]');
    expect(node).toBeDefined();
    expect(node?.value).toBe('dot-value');

    node = tree?.findNodeByPath('["c[0]"]');
    expect(node).toBeDefined();
    expect(node?.value).toBe('bracket-value');
  });
});
