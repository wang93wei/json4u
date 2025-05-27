"use client";

import { useEffect, type ComponentPropsWithoutRef } from "react";
import Loading from "@/components/Loading";
import { vsURL } from "@/lib/editor/cdn";
import { EditorWrapper, type Kind } from "@/lib/editor/editor";
import { useEditor, useEditorStore } from "@/stores/editorStore";
import { useStatusStore } from "@/stores/statusStore";
import { getTree, useTree } from "@/stores/treeStore"; // Added useTree
import { loader, Editor as MonacoEditor } from "@monaco-editor/react";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/shallow";

loader.config({ paths: { vs: vsURL } });

interface EditorProps extends ComponentPropsWithoutRef<typeof MonacoEditor> {
  kind: Kind;
}

export default function Editor({ kind, ...props }: EditorProps) {
  const translations = useTranslations();
  const setEditor = useEditorStore((state) => state.setEditor);
  const setTranslations = useEditorStore((state) => state.setTranslations);

  useDisplayExample(kind); // Pass kind
  useRevealNode(kind); // Pass kind
  useSyncFold(kind); // Add this call

  return (
    <MonacoEditor
      language="json"
      loading={<Loading />}
      options={{
        fontSize: 13, // 设置初始字体大小
        scrollBeyondLastLine: false, // 行数超过一屏时才展示滚动条
        automaticLayout: true, // 当编辑器所在的父容器的大小改变时，编辑器会自动重新计算并调整大小
        wordWrap: "on",
        minimap: { enabled: false },
        stickyScroll: {
          enabled: true,
          defaultModel: "foldingProviderModel",
        },
      }}
      onMount={(editor, monaco) => {
        if (!window.monacoApi) {
          window.monacoApi = {
            KeyCode: monaco.KeyCode,
            MinimapPosition: monaco.editor.MinimapPosition,
            OverviewRulerLane: monaco.editor.OverviewRulerLane,
            Range: monaco.Range,
            RangeFromPositions: monaco.Range.fromPositions,
          };
        }
        // used for e2e tests.
        window.monacoApi[kind] = editor;

        const wrapper = new EditorWrapper(editor, kind);
        wrapper.init();
        setEditor(wrapper);
        setTranslations(translations);
        console.l(`finished initial editor ${kind}:`, wrapper);
      }}
      {...props}
    />
  );
}

// reveal position in text
export function useRevealNode(kind: Kind) { // Added kind parameter
  const editor = useEditor(kind); // Use kind
  const tree = useTree(kind); // Use kind to get specific tree
  const { isNeedReveal, revealPosition } = useStatusStore(
    useShallow((state) => ({
      isNeedReveal: state.isNeedReveal("editor"),
      revealPosition: state.revealPosition,
    })),
  );

  useEffect(() => {
    const { treeNodeId, type } = revealPosition;

    if (editor && tree && isNeedReveal && treeNodeId) { // Check tree
      const node = tree.node(treeNodeId); // Use specific tree's node method
      if (node) {
        editor.revealOffset((type === "key" ? node.boundOffset : node.offset) + 1);
      }
    }
  }, [editor, tree, revealPosition, isNeedReveal, kind]); // Added tree and kind to dependencies
}

const exampleData = `{
  "Aidan Gillen": {
      "array": [
          "Game of Thron\\"es",
          "The Wire"
      ],
      "string": "some string",
      "int": 2,
      "aboolean": true,
      "boolean": true,
      "null": null,
      "a_null": null,
      "another_null": "null check",
      "object": {
          "foo": "bar",
          "object1": {
              "new prop1": "new prop value"
          },
          "object2": {
              "new prop1": "new prop value"
          },
          "object3": {
              "new prop1": "new prop value"
          },
          "object4": {
              "new prop1": "new prop value"
          }
      }
  },
  "Amy Ryan": {
      "one": "In Treatment",
      "two": "The Wire"
  },
  "Annie Fitzgerald": [
      "Big Love",
      "True Blood"
  ],
  "Anwan Glover": [
      "Treme",
      "The Wire"
  ],
  "Alexander Skarsgard": [
      "Generation Kill",
      "True Blood"
  ],
  "Clarke Peters": null
}`;

function useDisplayExample(kind: Kind) { // Added kind parameter
  const editor = useEditor(kind); // Use kind
  const incrEditorInitCount = useStatusStore((state) => state.incrEditorInitCount);

  useEffect(() => {
    if (editor && incrEditorInitCount() <= 1) {
      editor.parseAndSet(exampleData);
    }
  }, [editor, kind]); // Added kind to dependencies
}

// Hook to synchronize folding actions from statusStore
function useSyncFold(kind: Kind) {
  const lastFoldAction = useStatusStore(useShallow((state) => state.lastFoldAction));
  const editorWrapper = useEditor(kind);

  useEffect(() => {
    if (editorWrapper && lastFoldAction) {
      // console.l(`[${kind}] Received fold action:`, lastFoldAction);
      editorWrapper.applyFoldAction(lastFoldAction);
    }
  }, [lastFoldAction, editorWrapper, kind]);
}
