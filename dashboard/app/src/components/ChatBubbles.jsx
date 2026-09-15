import React from 'react';
import { Tag } from 'antd';
import Markdown from './Markdown.jsx';
import { splitTurnText } from '../lib/chat.js';

// One checkpoint reads as a real conversation: what the user reported on the right, the
// unverified agent reply on the left. Shared by 对话回溯, every detail modal and the
// table previews so one memory never renders as a wall of concatenated text.
const AGENT_FALLBACK = 'agent';

function stamp(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return text.includes('T') ? text.replace('T', ' ').slice(0, 19) : text;
}

export function ChatExchange({ task, text, request: requestProp, reply: replyProp, host, head }) {
  const parsed = splitTurnText(text);
  const request = String(requestProp ?? parsed.request ?? '').trim() || String(task ?? '').trim();
  const reply = String(replyProp ?? parsed.reply ?? '').trim();
  if (!request && !reply) return null;
  return (
    <div className="chat-exchange">
      {head && <div className="chat-exchange-head">{head}</div>}
      {request && (
        <div className="chat-row chat-row--user">
          <div className="chat-bubble chat-bubble--user chat-bubble--static">
            <Markdown>{request}</Markdown>
          </div>
          <span className="chat-avatar">我</span>
        </div>
      )}
      {reply && (
        <div className="chat-row chat-row--agent">
          <span className="chat-avatar chat-avatar--agent">{host || AGENT_FALLBACK}</span>
          <div className="chat-bubble chat-bubble--agent chat-bubble--static">
            <Markdown>{reply}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

// Several exchanges (an event's contexts, a session's checkpoints) in one scroll area.
export function ChatThread({ rows, host }) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && (row.text || row.task)) : [];
  if (!list.length) return null;
  return (
    <div className="detail-chat">
      {list.map((row, i) => (
        <ChatExchange
          key={row.id || row.event_id || i}
          task={row.task}
          text={row.text}
          host={row.agent || host}
          head={list.length > 1 ? (
            <>
              <span className="muted">{row.id || stamp(row.occurred_at) || `第 ${i + 1} 段`}</span>
              {row.certainty && <Tag color="blue">{row.certainty}</Tag>}
              {row.lifecycle && <Tag>{row.lifecycle}</Tag>}
            </>
          ) : null}
        />
      ))}
    </div>
  );
}

// Table-cell variant: the same request/reply split, clamped to two lines per side so a
// checkpoint row stays scannable instead of wrapping a kilobyte of prompt text.
export function ChatPreview({ task, text, host }) {
  const parsed = splitTurnText(text);
  const request = String(parsed.request ?? '').trim() || String(task ?? '').trim();
  const reply = String(parsed.reply ?? '').trim();
  if (!request && !reply) return <span className="muted">—</span>;
  return (
    <div className="cell-chat">
      {request && (
        <div className="cell-chat-line">
          <span className="cell-chat-who">我</span>
          <span className="cell-chat-text">{request}</span>
        </div>
      )}
      {reply && (
        <div className="cell-chat-line">
          <span className="cell-chat-who cell-chat-who--agent">{host || AGENT_FALLBACK}</span>
          <span className="cell-chat-text cell-chat-text--agent">{reply}</span>
        </div>
      )}
    </div>
  );
}
