import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import {
  AIExtension,
  AIMenuController,
  AIToolbarButton,
  getAISlashMenuItems,
} from "@blocknote/xl-ai";
import { en as aiEn } from "@blocknote/xl-ai/locales";
import { DefaultChatTransport } from "ai";
import {
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
} from "@blocknote/react";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { en } from "@blocknote/core/locales";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "@blocknote/xl-ai/style.css";

import { useCallback, useEffect, useMemo, useState } from "react";
import "./types";

function App() {
  const [theme, setThemeState] = useState<"light" | "dark">("light");

  // Build AI transport — reads the injected API key from window
  const aiTransport = useMemo(() => {
    const endpoint =
      window.AI_ENDPOINT || "https://api.openai.com/v1/chat/completions";
    return new DefaultChatTransport({
      api: endpoint,
      headers: (): Record<string, string> => {
        const key = window.AI_API_KEY;
        if (!key) return {} as Record<string, string>;
        return {
          Authorization: `Bearer ${key}`,
        } as Record<string, string>;
      },
    });
  }, []);

  // Create the BlockNote editor with AI extension
  const editor = useCreateBlockNote({
    dictionary: {
      ...en,
      ai: aiEn,
    },
    extensions: [
      AIExtension({
        transport: aiTransport,
      }),
    ],
  });

  // Expose editor instance for Swift bridge
  useEffect(() => {
    (window as any).blocknoteEditor = editor;
  }, [editor]);

  // Bridge: content change handler → Swift
  useEffect(() => {
    const onChange = () => {
      const blocks = editor.document;
      const blocksJSON = JSON.stringify(blocks);

      // Extract title from the first heading or paragraph block
      let title: string | undefined;
      if (blocks.length > 0) {
        const first = blocks[0];
        if (first.content && Array.isArray(first.content)) {
          title = first.content
            .map((c: any) => (typeof c === "string" ? c : c.text || ""))
            .join("");
        }
      }

      window.webkit?.messageHandlers?.editorBridge?.postMessage({
        type: "contentChange",
        blocksJSON,
        title,
      });
    };

    editor.onChange(onChange);
  }, [editor]);

  // Bridge: load document from Swift
  const loadDocument = useCallback(
    (blocks: any[]) => {
      if (blocks && blocks.length > 0) {
        editor.replaceBlocks(editor.document, blocks);
      }
    },
    [editor]
  );

  // Bridge: set theme from Swift
  const setTheme = useCallback((t: "light" | "dark") => {
    setThemeState(t);
  }, []);

  // Register bridge functions on window
  useEffect(() => {
    window.loadDocument = loadDocument;
    window.setTheme = setTheme;

    // Notify Swift that the editor is ready
    window.webkit?.messageHandlers?.editorBridge?.postMessage({
      type: "ready",
    });

    return () => {
      delete window.loadDocument;
      delete window.setTheme;
    };
  }, [loadDocument, setTheme]);

  // Detect system dark mode when not in native wrapper
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      // Only auto-switch if Swift hasn't set the theme
      if (!window.webkit?.messageHandlers?.editorBridge) {
        setThemeState(e.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", handler);
    // Set initial
    if (!window.webkit?.messageHandlers?.editorBridge) {
      setThemeState(mq.matches ? "dark" : "light");
    }
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        background: theme === "dark" ? "#1e1e1e" : "#ffffff",
        color: theme === "dark" ? "#e0e0e0" : "#1a1a1a",
      }}
    >
      <BlockNoteView
        editor={editor}
        theme={theme}
        formattingToolbar={false}
        slashMenu={false}
      >
        {/* Custom formatting toolbar with AI button */}
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>
              {...getFormattingToolbarItems()}
              <AIToolbarButton />
            </FormattingToolbar>
          )}
        />

        {/* Slash menu with AI items */}
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                ...getDefaultReactSlashMenuItems(editor),
                ...getAISlashMenuItems(editor),
              ],
              query
            )
          }
        />

        {/* AI menu controller (handles /ai interactions) */}
        <AIMenuController />
      </BlockNoteView>
    </div>
  );
}

export default App;
