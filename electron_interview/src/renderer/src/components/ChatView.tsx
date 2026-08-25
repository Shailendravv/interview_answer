import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

interface ChatViewProps {
  messages: ChatMessage[];
}

function MarkdownBlock({ content }: { content: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1({ children }) {
          return (
            <h1 className="text-base font-bold text-emerald-300 mt-3 mb-1 border-b border-white/10 pb-0.5">
              {children}
            </h1>
          );
        },
        h2({ children }) {
          return (
            <h2 className="text-sm font-bold text-emerald-400 mt-3 mb-1 border-b border-emerald-500/20 pb-0.5">
              {children}
            </h2>
          );
        },
        h3({ children }) {
          return (
            <h3 className="text-xs font-semibold text-emerald-300 uppercase tracking-wide mt-2 mb-1">
              {children}
            </h3>
          );
        },
        p({ children }) {
          return <p className="text-sm text-gray-100 leading-relaxed mb-1">{children}</p>;
        },
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="bg-white/20 text-emerald-300 px-1 py-0.5 rounded text-sm"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <pre className="bg-black/40 backdrop-blur-md rounded-lg p-4 overflow-x-auto my-2">
              <code className="text-sm text-gray-100" {...props}>
                {children}
              </code>
            </pre>
          );
        },
        strong({ children }) {
          return (
            <strong className="text-emerald-300 font-semibold">
              {children}
            </strong>
          );
        },
        ul({ children }) {
          return (
            <ul className="list-disc list-inside space-y-1 my-1 text-gray-100">
              {children}
            </ul>
          );
        },
        ol({ children }) {
          return (
            <ol className="list-decimal list-inside space-y-1 my-1 text-gray-100">
              {children}
            </ol>
          );
        },
        li({ children }) {
          return <li className="text-gray-100 text-sm">{children}</li>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function StreamingCursor({ isStreaming }: { isStreaming: boolean }): JSX.Element {
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    if (!isStreaming) {
      setShowCursor(false);
      return;
    }

    const interval = setInterval(() => {
      setShowCursor((v) => !v);
    }, 530);

    return () => clearInterval(interval);
  }, [isStreaming]);

  if (!isStreaming || !showCursor) return <></>;

  return (
    <span className="inline-block w-[2px] h-[1em] bg-emerald-400 ml-0.5" />
  );
}

interface MessageRowProps {
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
}

// Memoized per-message: token batches only change the LAST message, so every
// earlier bubble skips re-render (and re-parsing its markdown) entirely.
const MessageRow = memo(
  function MessageRow({ role, content, isStreaming }: MessageRowProps): JSX.Element {
    const isUser = role === "user";
    return (
      <div
        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      >
        <div
          className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
            isUser
              ? "bg-emerald-500/20 backdrop-blur-lg text-gray-100 rounded-br-md"
              : "bg-white/10 backdrop-blur-lg text-gray-100 rounded-bl-md border border-white/20"
          }`}
        >
          {isUser ? (
            <p className="text-sm">{content}</p>
          ) : isStreaming ? (
            // Plain text while tokens arrive: no markdown re-parse per batch.
            // Markdown rendering kicks in once the answer completes.
            <span className="whitespace-pre-wrap">
              {content}
              <StreamingCursor isStreaming={isStreaming} />
            </span>
          ) : (
            <MarkdownBlock content={content} />
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.role === next.role &&
    prev.content === next.content &&
    prev.isStreaming === next.isStreaming
);

export function ChatView({ messages }: ChatViewProps): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  const lastIsStreaming = Boolean(last?.role === "assistant" && last?.isStreaming);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: lastIsStreaming ? "auto" : "smooth",
    });
  }, [messages.length, last?.content, lastIsStreaming]);

  if (messages.length === 0) return <></>;

  return (
    <div className="flex flex-col space-y-2">
      {messages.map((msg, i) => (
        <MessageRow
          key={`${msg.role}-${i}`}
          role={msg.role}
          content={msg.content}
          isStreaming={Boolean(msg.role === "assistant" && msg.isStreaming)}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
