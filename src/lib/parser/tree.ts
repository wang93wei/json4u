import { getParentId, rootMarker } from "@/lib/idgen";
import * as jsonc from "jsonc-parser";
import { isEmpty, repeat } from "lodash-es";
import { union } from "lodash-es";
import {
  type Node,
  type ContextError,
  ParseOptions,
  isIterable,
  getChildrenKeys,
  getChildId,
  getRawValue,
  computeAndSetBoundLength,
  hasChildren,
  isRoot,
} from "./node";

export interface StringifyOptions extends ParseOptions {
  pure?: boolean;
}

// used for web worker
export interface TreeObject {
  nodeMap: Record<string, Node>;
  text: string;
  errors?: ContextError[];
  version?: number;
}

const emptyTree: Readonly<TreeObject> = {
  nodeMap: {},
  text: "",
  errors: undefined,
  version: undefined,
};
const treeProperties = Object.keys(emptyTree) as (keyof TreeObject)[];

export class Tree implements TreeObject {
  nodeMap: Record<string, Node>;
  text: string;
  nestNodeMap?: Record<string, Node>;
  errors?: ContextError[];
  version?: number;

  constructor(text: string = "") {
    this.nodeMap = {};
    this.text = text;
  }

  static assign<A extends Tree | TreeObject, B extends Tree | TreeObject>(a: A, b: B) {
    for (const key of treeProperties) {
      if (b[key] !== undefined) {
        (a as any)[key] = b[key];
      }
    }
    return a;
  }

  static fromObject(treeObject: TreeObject, nestNodeMap?: Record<string, Node>) {
    const tree = Tree.assign(new Tree(), treeObject);
    tree.nestNodeMap = nestNodeMap;
    return tree;
  }

  toObject(): TreeObject {
    return Tree.assign({} as TreeObject, this);
  }

  valid() {
    return this.root() && !this.hasError();
  }

  root() {
    return this.node(rootMarker);
  }

  isRoot(node: Node) {
    return node.id === rootMarker;
  }

  node(id: string) {
    return this.nodeMap[id];
  }

  getNodeToken(node: Node) {
    return this.text.slice(node.offset, node.offset + node.length);
  }

  getChild(node: Node, key: string): Node | undefined {
    return this.nodeMap[getChildId(node, key)];
  }

  childrenIds(node: Node): string[] {
    return getChildrenKeys(node).map((key) => getChildId(node, key));
  }

  childrenNodes(node: Node): Node[] {
    return getChildrenKeys(node).map((key) => this.getChild(node, key)!);
  }

  nonLeafChildrenNodes(node: Node): Node[] {
    return this.childrenNodes(node).filter(hasChildren);
  }

  mapChildren<T>(node: Node, fn: (child: Node, key: string, index: number) => T): T[] {
    return getChildrenKeys(node).map((key, i) => fn(this.getChild(node, key)!, key, i));
  }

  hasChildren() {
    return !!this.root();
  }

  hasError() {
    return !isEmpty(this.errors);
  }

  isGraphNode(node: Node) {
    return isRoot(node) || hasChildren(node);
  }

  getGraphNodeId(nodeId: string) {
    const node = this.node(nodeId);
    return this.isGraphNode(node) ? nodeId : getParentId(nodeId);
  }

  findNodeAtOffset(offset: number): { node: Node; type: "node" | "key" | "value" } | undefined {
    if (!this.valid()) {
      return undefined;
    }

    const inBound = (node: Node) => {
      // Because cursor-text appears to be on the left side of the character, so (boundLeft, boundRight]
      return node.boundOffset < offset && offset <= node.boundOffset + node.boundLength;
    };

    const doFind = (node: Node): Node | undefined => {
      if (!inBound(node)) {
        return undefined;
      }

      const keys = getChildrenKeys(node);
      let left = 0;
      let right = keys.length - 1;

      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const child = this.getChild(node, keys[mid])!;

        if (inBound(child)) {
          const item = doFind(child);
          return item ? item : child;
        }

        if (child.boundOffset + child.boundLength < offset) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }

      return node;
    };

    const node = doFind(this.root());
    if (!node) {
      return undefined;
    }

    if (this.isGraphNode(node)) {
      return { node, type: "node" };
    } else {
      return { node, type: node.offset < offset && offset <= node.offset + node.length ? "value" : "key" };
    }
  }

  // TODO support pretty format
  stringifyNode(
    node: Node,
    options: StringifyOptions = {},
    indentLevel: number = 0,
    offset: number = 0, // the starting offset of the current node in the stringify text.
    boundOffset: number = 0, // the starting offset of the current node's bound in the stringify text.
    genTabs: ReturnType<typeof getGenTabsFn> = getGenTabsFn(options.tabWidth || 2),
  ): string {
    if (!isIterable(node)) {
      // Use nullish coalescing to default to an empty string if getRawValue returns null/undefined, preventing potential errors.
      const stringified = getRawValue(node) ?? "";

      if (!options.pure) {
        node.length = stringified.length;
        node.offset = offset;
        node.boundOffset = boundOffset ?? node.offset;
        computeAndSetBoundLength(node);
      }

      return stringified;
    }

    // for array or object, the bound width is equal to the node width
    if (!options.pure) {
      node.boundOffset = boundOffset ?? 0;
      node.offset = offset;
    }

    const isFormat = options?.format === true;
    const isObject = node.type === "object";
    let stringified = isObject ? "{" : "[";

    const keys = getChildrenKeys(node);

    if (isObject) {
      if (options?.sort === "asc") {
        keys.sort();
      } else if (options?.sort === "desc") {
        keys.sort().reverse();
      }
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const child = this.getChild(node, key)!;

      if (isFormat) {
        stringified += "\n" + genTabs(indentLevel + 1);
      }

      const childBoundOffset = offset + stringified.length;
      if (isObject) {
        stringified += `"${key}":${isFormat ? " " : ""}`;
      }
      const childOffset = offset + stringified.length;

      stringified += this.stringifyNode(child, options, indentLevel + 1, childOffset, childBoundOffset, genTabs);

      if (i < keys.length - 1) {
        stringified += ",";
      } else if (isFormat) {
        stringified += "\n" + genTabs(indentLevel);
      }
    }

    stringified += isObject ? "}" : "]";

    if (!options.pure) {
      node.length = stringified.length;
      computeAndSetBoundLength(node);
    }

    return stringified;
  }

  stringify(options: StringifyOptions = {}): string {
    const root = this.root();
    this.text = this.stringifyNode(root, options);
    root.length = this.text.length;
    return this.text;
  }

  stringifyNestNodes(options: StringifyOptions = {}) {
    let acc = 0;
    const edits: jsonc.Edit[] = [];

    const fixOffset = (node: Node) => {
      // fix offset for nest nodes
      if (this.nestNodeMap?.[node.id]) {
        const edit = {
          offset: node.offset,
          length: node.length,
          content: this.stringifyNode(node, options, 0, node.offset + acc, node.boundOffset + acc),
        };

        edits.push(edit);
        acc += edit.content.length - edit.length;
      } else {
        // fix offset for successor node of the nest node
        node.offset += acc;
        node.boundOffset += acc;

        // fix length for parent of the nest node
        const old = acc;
        this.mapChildren(node, fixOffset);
        node.length += acc - old;
        node.boundLength += acc - old;
      }
    };

    fixOffset(this.root());
    this.text = jsonc.applyEdits(this.text, edits).trim();
  }

  toJSON(node = this.root()): string | number | boolean | object | any[] | null {
    if (!isIterable(node)) {
      return node.value;
    }

    if (node.type === "object") {
      const obj: Record<string, unknown> = {};
      this.mapChildren(node, (node, key, i) => {
        obj[key] = this.toJSON(node);
      });
      return obj;
    } else {
      return this.mapChildren(node, (node) => this.toJSON(node));
    }
  }
}

export function getGenTabsFn(tabWidth: number) {
  const tab = repeat(" ", tabWidth);
  const cached = [""];

  return (level: number): string => {
    for (let i = cached.length - 1; i < level; i++) {
      cached.push(cached[i] + tab);
    }
    return cached[level];
  };
}

export function isEquals(tree1: Tree, tree2: Tree): boolean {
  const doIsEquals = (node1: Node, node2: Node): boolean => {
    if (node1.type !== node2.type) {
      return false;
    }

    const keys = union(getChildrenKeys(node1), getChildrenKeys(node2));

    if (keys.length === 0) {
      return getRawValue(node1) === getRawValue(node2);
    }

    for (const key of keys) {
      const child1 = tree1.getChild(node1, key);
      const child2 = tree2.getChild(node2, key);

      if (!child1 || !child2) {
        return false;
      } else if (!doIsEquals(child1, child2)) {
        return false;
      }
    }

    return true;
  };

  return doIsEquals(tree1.root(), tree2.root());
}
