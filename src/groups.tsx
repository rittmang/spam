import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Hash,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
  Check,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { api } from './api';
import type { GroupDirectoryResponse, WatchtowerGroup } from '../shared/types';

export function GroupSwitcher({
  current,
  groups,
  onSelect,
  onManage,
}: {
  current: WatchtowerGroup;
  groups: WatchtowerGroup[];
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="group-switcher" ref={ref}>
      <button
        className="workspace"
        aria-label="Switch Telegram group"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="workspace-icon">
          <Hash size={17} />
        </span>
        <div>
          <strong>{current.title}</strong>
          <span>{current.chat_id}</span>
        </div>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="group-menu" aria-label="Telegram groups">
          {groups
            .filter((g) => g.provisioned)
            .map((g) => (
              <button
                key={g.chat_id}
                aria-current={g.chat_id === current.chat_id ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(g.chat_id);
                }}
              >
                <div>
                  <strong>{g.title}</strong>
                  <span>
                    {g.status === 'active' ? g.chat_id : 'Reconnect to resume · history available'}
                  </span>
                </div>
                {g.chat_id === current.chat_id && <Check size={15} />}
              </button>
            ))}
          <button
            className="group-manage-link"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Plus size={16} />
            Add or manage groups{' '}
            {groups.some((g) => !g.provisioned) && <span className="group-pending-dot" />}
          </button>
        </div>
      )}
    </div>
  );
}

export function GroupManager({
  directory,
  current,
  refresh,
  onActivated,
  onClose,
}: {
  directory: GroupDirectoryResponse;
  current: string;
  refresh: () => Promise<void>;
  onActivated: (id: string) => void;
  onClose: () => void;
}) {
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [copyFrom, setCopyFrom] = useState(current);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const nodes = [
        ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a,select,input') ||
          []),
      ];
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);
  async function action(id: string, activate: boolean) {
    if (working.has(id)) return;
    setWorking((s) => new Set([...s, id]));
    setError('');
    try {
      await api(`/groups/${id}/${activate ? 'activate' : 'check'}`, {
        method: 'POST',
        body: JSON.stringify(activate && copyFrom ? { copyFrom } : {}),
      });
      await refresh();
      if (activate) onActivated(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking((s) => new Set([...s].filter((v) => v !== id)));
    }
  }
  const link = directory.botUsername
    ? `https://t.me/${encodeURIComponent(directory.botUsername)}?startgroup=watchtower&admin=delete_messages+restrict_members`
    : '';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="modal group-manager"
        role="dialog"
        aria-modal="true"
        aria-label="Connect Telegram groups"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">YOUR GROUPS</span>
            <h2>One watchtower. More communities.</h2>
          </div>
          <button className="icon-button" aria-label="Close group setup" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <p className="group-intro">
          Add the bot as an administrator with Delete messages and Ban users. Your group appears
          below, ready for you to activate.
        </p>
        <div className="group-setup-actions">
          {link && (
            <a className="button primary" href={link} target="_blank" rel="noreferrer">
              <Plus size={16} />
              Add bot to a group
              <ExternalLink size={14} />
            </a>
          )}
          <button
            className="button secondary"
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            <RefreshCw size={15} />
            Refresh groups
          </button>
        </div>
        <p className="field-help">
          Already added it? Send <code>/watchtower</code> from your owner Telegram account in that
          group, then refresh. Full three-strike moderation requires a supergroup.
        </p>
        <label className="group-template">
          Settings for the next group
          <select
            aria-label="New group settings"
            value={copyFrom}
            onChange={(e) => setCopyFrom(e.target.value)}
          >
            <option value="">Start with the default policy</option>
            {directory.groups
              .filter((g) => g.provisioned)
              .map((g) => (
                <option key={g.chat_id} value={g.chat_id}>
                  Copy from {g.title}
                </option>
              ))}
          </select>
          <small>
            Copies policy, model, thresholds and limits. Every new group starts in Observe;
            messages, strikes and labels stay separate.
          </small>
        </label>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <div className="group-cards">
          {directory.groups.map((g) => {
            const ready =
              g.chat_type === 'supergroup' &&
              g.bot_status === 'administrator' &&
              !!g.can_delete &&
              !!g.can_ban;
            const busy = working.has(g.chat_id);
            return (
              <article className="group-card" key={g.chat_id}>
                <div className="group-card-heading">
                  <div>
                    <strong>{g.title}</strong>
                    <code>{g.chat_id}</code>
                  </div>
                  <span className={`tag ${g.status === 'active' ? 'group-active' : ''}`}>
                    {g.status === 'active'
                      ? 'Connected'
                      : g.status === 'removed'
                        ? 'Bot removed'
                        : g.status === 'needs_permissions'
                          ? 'Permissions changed'
                          : 'Awaiting activation'}
                  </span>
                </div>
                <div className="group-permissions">
                  <span>
                    <Check size={13} />
                    Detected
                  </span>
                  <span className={g.bot_status === 'administrator' ? 'ok' : ''}>
                    Administrator {g.bot_status === 'administrator' ? '✓' : 'needed'}
                  </span>
                  <span className={g.can_delete ? 'ok' : ''}>
                    Delete {g.can_delete ? '✓' : 'needed'}
                  </span>
                  <span className={g.can_ban ? 'ok' : ''}>Ban {g.can_ban ? '✓' : 'needed'}</span>
                </div>
                {g.chat_type !== 'supergroup' && (
                  <p className="field-help">
                    Waiting for Telegram to upgrade this group to a supergroup. Its new ID will be
                    detected separately.
                  </p>
                )}
                <div className="group-card-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void action(g.chat_id, false)}
                  >
                    <RefreshCw size={14} />
                    Check permissions
                  </button>
                  {g.status !== 'active' && (
                    <button
                      className="button primary"
                      disabled={busy || !ready}
                      onClick={() => void action(g.chat_id, true)}
                    >
                      {busy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
                      {g.provisioned ? 'Reconnect in Observe' : 'Activate in Observe'}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
