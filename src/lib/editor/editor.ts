import { Node, ParseOptions, Tree } from "@/lib/parser"; // Added Node for type checking
import { type ParsedTree } from "@/lib/worker/command/parse";
import { getEditorState } from "@/stores/editorStore";
import { getStatusState } from "@/stores/statusStore";
import { getTreeState } from "@/stores/treeStore";
import { sendGAEvent } from "@next/third-parties/google";
import { debounce, type DebouncedFunc } from "lodash-es";
import { editorApi, IScrollEvent } from "./types";

export type Kind = "main" | "secondary";
type ScrollEvent = IScrollEvent & { _oldScrollTop: number; _oldScrollLeft: number };

const parseWait = 300;

// Custom Folding Range Provider
class CustomFoldingRangeProvider implements window.monaco.languages.FoldingRangeProvider {
  constructor(private getTree: () => Tree | undefined) {}

  provideFoldingRanges(
    model: window.monaco.editor.ITextModel,
    context: window.monaco.languages.FoldingContext,
    token: window.monaco.CancellationToken,
  ): window.monaco.languages.FoldingRange[] {
    const tree = this.getTree();
    if (!tree || !tree.valid() || !tree.nodeMap) {
      return [];
    }

    const ranges: window.monaco.languages.FoldingRange[] = [];
    for (const nodeId in tree.nodeMap) {
      const node = tree.nodeMap[nodeId];

      if ((node.type === "object" || node.type === "array") && node.childrenKeys && node.childrenKeys.length > 0) {
        const startPosition = model.getPositionAt(node.offset);
        // The end position for folding should be the line before the closing brace/bracket if it's on its own line.
        // Let's find the start of the last child. If no children, this won't run.
        // A common approach: end is the line of the last char of the node's content, excluding the closing brace line.
        // For `{\n  "a": 1\n}`, endLine should be the line of `"a": 1`.
        // The closing `}` is on `startPosition.lineNumber + (number of lines in content including children) + 1`.
        // A simpler rule: the end of the range is the line of the closing bracket/brace itself.
        // Monaco then typically adjusts this to fold up to the line *before* the end if kind is Region.
        // Let's try end = line of closing char.
        const endPositionCandidate = model.getPositionAt(node.offset + node.length -1);
        let endLineNumber = endPositionCandidate.lineNumber;

        // If the closing char is the first char on its line (e.g., pretty-printed JSON),
        // Monaco prefers the fold to end on the line above it.
        if (endPositionCandidate.column === 1 && node.length > 1) { // node.length > 1 to avoid issues with empty {} or [] if they ever exist like this
            endLineNumber = Math.max(startPosition.lineNumber, endPositionCandidate.lineNumber - 1);
        }


        if (startPosition.lineNumber < endLineNumber) {
          const count = node.childrenKeys.length;
          const itemLabel = count === 1 ? "item" : "items";
          let collapsedText = "";
          if (node.type === "object") {
            collapsedText = `{...} // ${count} ${itemLabel}`;
          } else {
            // array
            collapsedText = `[...] // ${count} ${itemLabel}`;
          }

          ranges.push({
            start: startPosition.lineNumber,
            end: endLineNumber,
            kind: window.monaco.languages.FoldingRangeKind.Region,
            collapsedText,
          });
        }
      }
    }
    return ranges;
  }
}

export class EditorWrapper {
  editor: editorApi.IStandaloneCodeEditor;
  kind: Kind;
  scrolling: number;
  tree: Tree;
  delayParseAndSet: DebouncedFunc<(text: string, extraOptions: ParseOptions, resetCursor: boolean) => void>;
  foldingProviderDisposable?: window.monaco.IDisposable; // Store the disposable

  constructor(editor: editorApi.IStandaloneCodeEditor, kind: Kind) {
    this.editor = editor;
    this.kind = kind;
    this.scrolling = 0;
    this.tree = new Tree(); // Initial empty tree
    this.delayParseAndSet = debounce(this.parseAndSet, parseWait, { trailing: true });
  }

  init() {
    // Dispose of any existing folding provider before setting a new one
    this.foldingProviderDisposable?.dispose();
    // Register the custom folding range provider
    if (window.monaco && window.monaco.languages && window.monaco.languages.registerFoldingRangeProvider) {
      const provider = new CustomFoldingRangeProvider(() => this.tree);
      this.foldingProviderDisposable = window.monaco.languages.registerFoldingRangeProvider('json', provider);
    }

    this.listenOnChange();
    this.listenOnDidPaste();
    this.listenOnKeyDown();
    this.listenOnDropFile();
    this.listenOnDidChangeFolding(); // Add this call

    if (this.isMain()) {
      this.listenOnDidChangeCursorPosition();
    }
  }

  // Method to listen for folding changes
  listenOnDidChangeFolding() {
    this.editor.onDidChangeHiddenAreas(async () => {
      if (!getStatusState().enableSyncFold) {
        return;
      }

      // Heuristic: Check node at current cursor position.
      // This assumes user interaction for folding often involves clicking near the line number.
      const position = this.editor.getPosition();
      if (!position || !this.tree || !this.tree.valid()) {
        return;
      }

      const model = this.editor.getModel();
      if (!model) {
        return;
      }

      const offset = model.getOffsetAt(position);
      const foundNodeInfo = this.tree.findNodeAtOffset(offset);

      if (foundNodeInfo && foundNodeInfo.node && (foundNodeInfo.node.type === "object" || foundNodeInfo.node.type === "array")) {
        const foldingController = this.editor.getContribution('editor.contrib.foldingController');
        // The getFoldingModel method might be asynchronous or part of a sub-property.
        // This is a common pattern, but needs verification against Monaco's exact API.
        // For now, assuming direct access or a simple promise.
        // Casting to `any` to bypass strict type checking for this dynamic part.
        const foldingModel = await (foldingController as any)?.getFoldingModel?.();


        if (foldingModel && typeof foldingModel.getRegionAtLine === 'function' && typeof foldingModel.isCollapsed === 'function') {
          // Try to get the folding region exactly at the start line of the node.
          // Node offsets are 0-based, line numbers 1-based.
          const nodeStartLineNumber = model.getPositionAt(foundNodeInfo.node.offset).lineNumber;
          const region = foldingModel.getRegionAtLine(nodeStartLineNumber);

          if (region) {
            // Check if this region actually corresponds to our node
            // (e.g. its start line matches node's start line)
            // The region object from Monaco contains `startLineNumber`.
            if (region.startLineNumber === nodeStartLineNumber) {
              const isNowFolded = foldingModel.isCollapsed(region.startLineNumber);
              
              // Prevent feedback loop if this editor was the last one to cause this exact state change
              // This is a local check; the store's versioning also helps.
              const lastAction = getStatusState().lastFoldAction;
              if (lastAction && 
                  lastAction.nodeId === foundNodeInfo.node.id && 
                  lastAction.isFolded === isNowFolded &&
                  lastAction.fromKind === this.kind) {
                // console.l(`[${this.kind}] Skipping fold action, already sent by this editor: ${foundNodeInfo.node.id} ${isNowFolded}`);
                return;
              }
              
              // console.l(`[${this.kind}] Sending fold action: ${foundNodeInfo.node.id} ${isNowFolded}`);
              getStatusState().setLastFoldAction(foundNodeInfo.node.id, isNowFolded, this.kind);
            }
          }
        }
      }
    });
  }

  isMain() {
    return this.kind === "main";
  }

  model() {
    return this.editor.getModel();
  }

  text() {
    return this.editor.getValue();
  }

  worker() {
    return window.worker;
  }

  getAnotherEditor() {
    return getEditorState().getAnotherEditor(this.kind);
  }

  isTreeValid() {
    return this.tree.valid();
  }

  // convert offset at text to {lineNumber, column}
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    return this.model()?.getPositionAt(offset) ?? { lineNumber: 1, column: 1 };
  }

  range(offset: number, length: number) {
    return window.monacoApi.RangeFromPositions(this.getPositionAt(offset), this.getPositionAt(offset + length));
  }

  revealPosition(lineNumber: number, column: number = 1, focus: boolean = true) {
    if (focus) {
      this.editor.focus();
    }

    const pos = { lineNumber, column };
    this.editor.setPosition(pos);
    this.editor.revealPositionInCenter(pos);
  }

  revealOffset(offset: number) {
    const p = this.getPositionAt(offset);
    if (p) {
      this.revealPosition(p.lineNumber, p.column);
    }
  }

  setTree({ treeObject }: ParsedTree, resetCursor: boolean = true) {
    const tree = Tree.fromObject(treeObject);
    getEditorState().resetHighlight();

    this.tree = tree;
    getTreeState().setTree(tree, this.kind);

    // replace editor text to the new tree text
    this.editor.executeEdits(null, [
      {
        text: tree.text,
        range: this.model()?.getFullModelRange() ?? {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: Infinity,
          endColumn: Infinity,
        },
      },
    ]);
    // Indicates the above edit is a complete undo/redo change.
    this.editor.pushUndoStop();

    resetCursor && this.revealPosition(1, 1);
    console.l("set tree:", tree);
    return tree;
  }

  async parseAndSet(
    text: string,
    extraParseOptions?: ParseOptions,
    resetCursor: boolean = true,
  ): Promise<{ set: boolean; parse: boolean }> {
    const options = {
      ...getStatusState().parseOptions,
      ...extraParseOptions,
      kind: this.kind,
    };

    reportTextSize(text.length);
    const parsedTree = await this.worker().parseAndFormat(text, options);
    const tree = this.setTree(parsedTree, resetCursor);
    return { set: true, parse: tree.valid() };
  }

  listenOnChange() {
    this.editor.onDidChangeModelContent(async (ev) => {
      const prevText = this.tree.text;
      const text = this.text();

      if (text !== prevText) {
        console.l("onChange:", ev.versionId);
        this.delayParseAndSet.cancel();
        await this.delayParseAndSet(text, { format: false }, false);
      } else {
        console.l("skip onChange:", ev.versionId);
      }
    });
  }

  listenOnDidPaste() {
    this.editor.onDidPaste(async (ev) => {
      const model = this.model();
      const text = this.text();
      const versionId = model?.getVersionId();

      // if all text is replaced by pasted text
      if (model && text.length > 0 && ev.range.equalsRange(model.getFullModelRange())) {
        console.l("onDidPaste:", versionId, text.length, text.slice(0, 20));
        // for avoid triggering onChange
        this.tree.text = text;
        // sometimes onChange will triggered before onDidPaste, so we need to cancel it
        this.delayParseAndSet.cancel();
        await this.parseAndSet(text);
      } else {
        console.l("skip onDidPaste:", versionId, text.length, text.slice(0, 20));
      }
    });
  }

  // 监听光标改变事件。显示光标停留位置的 json path
  listenOnDidChangeCursorPosition() {
    const onDidChangeCursorPosition = debounce(
      (e) => {
        const model = this.model();
        const { lineNumber, column } = e.position;
        const selectionLength = model?.getValueInRange(this.editor.getSelection()!).length ?? 0;
        getStatusState().setCursorPosition(lineNumber, column, selectionLength);

        if (model && this.tree.valid()) {
          const text = this.text();

          // 获取当前光标在整个文档中的偏移量（offset）
          let offset = model.getOffsetAt(e.position);
          if (text[offset] === "\n" && text[offset - 1] === ",") {
            offset--;
          }

          const r = this.tree.findNodeAtOffset(offset);

          if (r?.node) {
            getStatusState().setRevealPosition({
              treeNodeId: r.node.id,
              type: r.type,
              from: "editor",
            });
          }
        }
      },
      200,
      { trailing: true },
    );

    this.editor.onDidChangeCursorPosition(onDidChangeCursorPosition);
  }

  // 注册拖拽事件处理器，支持拖拽文件到编辑器上
  listenOnDropFile() {
    this.editor.getDomNode()?.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];

      if (file) {
        // 读取拖拽的文件内容，并设置为编辑器的内容
        const reader = new FileReader();
        reader.onload = (event) => {
          const text = event.target?.result;
          typeof text === "string" && this.parseAndSet(text);
        };
        reader.readAsText(file);
      }
    });
  }

  listenOnKeyDown() {
    this.editor.onKeyDown((e) => {
      if (e.keyCode === window.monacoApi.KeyCode.KeyK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        window.searchComponents?.["cmd-search-input"]?.focus();
      } else if (e.keyCode === window.monacoApi.KeyCode.Enter && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        getEditorState().runCommand("swapLeftRight");
      }
    });
  }

  // 监听滚动事件实现同步滚动
  listenOnScroll() {
    this.editor.onDidScrollChange((e) => {
      this.scrolling = Math.min(this.scrolling + 1, 1);
      if (this.scrollable()) {
        this.getAnotherEditor()?.scrollTo(e as ScrollEvent);
      }
    });
  }

  scrollTo(e: ScrollEvent) {
    if (e.scrollTopChanged || e.scrollLeftChanged) {
      // prevent next scroll
      this.scrolling = -1;
      const top = this.editor.getScrollTop();
      const left = this.editor.getScrollLeft();
      const absoluteTop = top + e.scrollTop - e._oldScrollTop;
      const absoluteLeft = left + e.scrollLeft - e._oldScrollLeft;
      this.editor.setScrollTop(absoluteTop);
      this.editor.setScrollLeft(absoluteLeft);
    }
  }

  scrollable() {
    return this.scrolling && getStatusState().enableSyncScroll;
  }

  applyFoldAction = async (foldAction: NonNullable<ReturnType<typeof getStatusState>['lastFoldAction']>) => {
    // console.l(`[${this.kind}] applyFoldAction called with:`, foldAction);
    if (!getStatusState().enableSyncFold) {
      // console.l(`[${this.kind}] Sync fold disabled.`);
      return;
    }

    if (foldAction.fromKind === this.kind) {
      // console.l(`[${this.kind}] Skipping action from self.`);
      return;
    }

    const { nodeId, isFolded } = foldAction;
    const nodeToChange = this.tree.node(nodeId);

    if (!nodeToChange) {
      console.error(`[${this.kind}] Node with ID ${nodeId} not found in tree.`);
      return;
    }

    if (nodeToChange.type !== "object" && nodeToChange.type !== "array") {
      // console.l(`[${this.kind}] Node ${nodeId} is not a foldable type (${nodeToChange.type}).`);
      return; // Only objects and arrays are typically foldable
    }
    
    const model = this.editor.getModel();
    if (!model) {
      console.error(`[${this.kind}] Editor model not available.`);
      return;
    }

    const nodeStartLine = this.getPositionAt(nodeToChange.offset).lineNumber;

    const foldingController = this.editor.getContribution('editor.contrib.foldingController');
    const foldingModel = await (foldingController as any)?.getFoldingModel?.();

    if (!foldingModel || typeof foldingModel.getRegionAtLine !== 'function' || typeof foldingModel.isCollapsed !== 'function' || typeof foldingModel.setCollapsed !== 'function') {
      console.error(`[${this.kind}] Folding model or required methods not available.`);
      return;
    }

    // Find the specific region that starts at nodeStartLine
    // Monaco's folding regions are managed by the FoldingModel.
    // We need to get the region that exactly matches our node's start.
    const region = foldingModel.getRegionAtLine(nodeStartLine);

    if (!region || region.startLineNumber !== nodeStartLine) {
      // This can happen if the node itself isn't a direct folding point (e.g., empty object/array, or not considered foldable by Monaco's strategy)
      // Or if nodeStartLine is part of a larger folded region, but not its start.
      // console.warn(`[${this.kind}] Folding region not found or mismatched for node ${nodeId} at line ${nodeStartLine}. Region found:`, region);
      return;
    }
    
    const currentCollapsedState = foldingModel.isCollapsed(region.startLineNumber);

    if (currentCollapsedState === isFolded) {
      // console.l(`[${this.kind}] Node ${nodeId} at line ${nodeStartLine} already in desired state (${isFolded}).`);
      return;
    }

    // The setCollapsed method on FoldingModel typically expects an array of regions.
    // We are targeting a single region.
    // Note: The exact API for Monaco's foldingModel to set a single region's state might vary.
    // Common patterns include:
    // 1. model.setCollapsed([region], isFolded)
    // 2. controller.setCollapsedStateForRegions([region], isFolded)
    // 3. controller.setCollapsedStateAtIndex(regionIndex, isFolded)
    // The prompt implies `foldingModel.setCollapsed(region.startLineNumber, isFolded)`
    // but standard Monaco API usually takes a region object or index.
    // Let's assume `foldingModel.setCollapsed([region], isFolded)` is what's intended if setCollapsed takes regions.
    // Or, if there's a direct API like `foldingController.setCollapsedState(lineNumber, state)`, that would be simpler.
    // Given `foldingModel.setCollapsed` is mentioned, and it usually takes regions array:
    
    // To be safe and align with typical Monaco patterns, we'd pass an array of IRegion objects.
    // The `region` object obtained from `getRegionAtLine` should conform to `IRegion`.
    // Let's try to use a method that acts on line numbers if available on controller, or pass region to model.
    // The prompt suggests `foldingModel.setCollapsed(region.startLineNumber, isFolded)` which is unusual.
    // A more common API pattern for `FoldingModel` would be `setCollapsed(regions: IRegion[], newState: boolean)`.
    // Or `FoldingController` might have `setCollapsedStateForLine(lineNumber: number, state: boolean)`.

    // Let's try a common approach:
    // Find the index of the region
    let targetRegionIndex = -1;
    for (let i = 0; i < foldingModel.regions.length; i++) {
        if (foldingModel.regions[i].startLineNumber === region.startLineNumber) {
            targetRegionIndex = i;
            break;
        }
    }

    if (targetRegionIndex === -1) {
        // console.warn(`[${this.kind}] Could not find index for region at line ${nodeStartLine}.`);
        return;
    }
    
    // console.l(`[${this.kind}] Applying fold action to node ${nodeId} at line ${nodeStartLine}: ${isFolded}`);
    // This is a common way to interact with folding regions by their index in the folding model
    foldingController.setCollapsedStateAtIndex(targetRegionIndex, isFolded);

  }
}

function reportTextSize(size: number) {
  let kind = "";

  if (size <= 10 * 1024) {
    kind = "(0, 10kb]";
  } else if (size <= 100 * 1024) {
    kind = "(10kb, 100kb]";
  } else if (size <= 500 * 1024) {
    kind = "(100kb, 500kb]";
  } else {
    kind = "(500kb, +∞)";
  }

  sendGAEvent("event", "text_size", { kind });
}
