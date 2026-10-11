import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useVisiblePoll } from './poll';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  FlaskConical,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
  LockKeyhole,
  Pause,
  FileJson,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import type {
  Dataset,
  Evaluation,
  Example,
  Label,
  Overview,
  Settings,
  StoredMessage,
  GroupDirectoryResponse,
  WatchtowerGroup,
} from '../shared/types';
import { metrics } from '../shared/metrics';
import { reviewedExamples, sameExample } from '../shared/review';
import { RunReview } from './RunReview';
import { applyReviewLabel, labelKey, LabelEdits, type LabelEdit } from './label-edits';
import { EvaluationReader } from './evaluation-load';
import { api, apiForGroup, download, downloadBlob, setApiGroup } from './api';
import { GroupManager, GroupSwitcher } from './groups';
import { streamExamples, type ImportProgress } from '../shared/import-stream';

type Page = 'overview' | 'messages' | 'users' | 'lab' | 'settings';
const pages: { id: Page; title: string; icon: typeof Shield }[] = [
  { id: 'overview', title: 'Overview', icon: LayoutDashboard },
  { id: 'messages', title: 'Message feed', icon: MessageSquare },
  { id: 'users', title: 'Strike history', icon: Users },
  { id: 'lab', title: 'Model lab', icon: FlaskConical },
  { id: 'settings', title: 'Settings', icon: Settings2 },
];
const number = (n: number) =>
  Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard' }).format(n);
const percent = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
const time = (date: number) =>
  new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const statusLabel: Record<string, string> = {
  allowed: 'Allowed',
  spam: 'Spam',
  observed_spam: 'Would flag',
  review: 'Review',
  protected: 'Exempt',
  unsupported: 'Media review',
  pending: 'Queued',
  error: 'Error',
  paused: 'Paused',
};
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      {['spam', 'observed_spam'].includes(status) && <span className="badge-dot" />}
      {statusLabel[status] || status}
    </span>
  );
}
function Avatar({ name, id }: { name: string; id?: string }) {
  const hue = ((id || name).split('').reduce((n, c) => n + c.charCodeAt(0), 0) * 47) % 360;
  return (
    <span
      className="avatar"
      style={{ background: `hsl(${hue} 25% 91%)`, color: `hsl(${hue} 25% 35%)` }}
    >
      {name
        .split(' ')
        .slice(0, 2)
        .map((n) => n[0])
        .join('')
        .toUpperCase() || '?'}
    </span>
  );
}
function Empty({
  icon: Icon = MessageSquare,
  title,
  children,
}: {
  icon?: typeof Shield;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export default function App() {
  const [directory, setDirectory] = useState<GroupDirectoryResponse | null>(null);
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem('watchtower:selected-group') || '';
    } catch {
      return '';
    }
  });
  const [manage, setManage] = useState(false),
    [error, setError] = useState('');
  const closeManager = useCallback(() => setManage(false), []);
  const load = useCallback(async () => {
    const value = await api<GroupDirectoryResponse>('/groups');
    setDirectory(value);
    setSelected((id) =>
      value.groups.some((g) => g.chat_id === id && g.provisioned) ? id : value.defaultChatId,
    );
    setError('');
  }, []);
  useVisiblePoll(load, manage ? 5000 : 60_000, (e) => setError(e.message));
  useLayoutEffect(() => {
    setApiGroup(selected);
    try {
      if (selected) localStorage.setItem('watchtower:selected-group', selected);
    } catch {
      /* Storage may be disabled. */
    }
  }, [selected]);
  const current = directory?.groups.find((g) => g.chat_id === selected && g.provisioned);
  if (!directory || !current)
    return (
      <main className="group-bootstrap">
        <ShieldCheck size={32} />
        <h1>Watchtower</h1>
        <p>{error || 'Loading your Telegram groups…'}</p>
        {error && (
          <button
            className="button primary"
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            Retry
          </button>
        )}
      </main>
    );
  return (
    <>
      <GroupWorkspace
        key={selected}
        group={current}
        groups={directory.groups}
        onSelect={setSelected}
        onManage={() => setManage(true)}
      />
      {manage && (
        <GroupManager
          directory={directory}
          current={selected}
          refresh={load}
          onClose={closeManager}
          onActivated={(id) => {
            setSelected(id);
            setManage(false);
          }}
        />
      )}
    </>
  );
}

function GroupWorkspace({
  group,
  groups,
  onSelect,
  onManage,
}: {
  group: WatchtowerGroup;
  groups: WatchtowerGroup[];
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const api = useMemo(() => apiForGroup(group.chat_id), [group.chat_id]);
  const [page, setPage] = useState<Page>((location.hash.slice(1) as Page) || 'overview');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [detail, setDetail] = useState<StoredMessage | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const reload = useCallback(async () => {
    try {
      setData(await api<Overview>('/overview'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [api]);
  useVisiblePoll(reload, page === 'lab' || page === 'settings' ? 60_000 : 30_000, (e) =>
    setError(e.message),
  );
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const onHash = () => {
      const value = location.hash.slice(1);
      if (pages.some((p) => p.id === value)) setPage(value as Page);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!detail && !setup) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>('.modal button')?.focus(),
    );
    function keydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setDetail(null);
        setSetup(false);
      }
      if (e.key !== 'Tab') return;
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          '.modal button:not(:disabled), .modal a, .modal select, .modal input, .modal textarea',
        ),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, [Boolean(detail), setup]);
  function navigate(page: Page) {
    setPage(page);
    location.hash = page;
    setMobileNav(false);
  }
  async function act(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await fn();
      if (success) setToast({ text: success, error: false });
      await reload();
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }
  const storageWaiting = data?.storage?.ready === false;
  const mode = storageWaiting ? 'paused' : data?.settings.mode || 'observe';
  const modelReady = data?.providers.find((p) => p.id === data.settings.provider)?.configured;
  async function exportMessages() {
    const messages: StoredMessage[] = [];
    let cursor: number | null = null;
    for (;;) {
      const result: { messages: StoredMessage[]; nextCursor: number | null } = await api<{
        messages: StoredMessage[];
        nextCursor: number | null;
      }>(`/export${cursor ? `?before=${cursor}` : ''}`);
      messages.push(...result.messages);
      cursor = result.nextCursor;
      if (cursor === null || !result.messages.length) break;
    }
    const examples = [...messages]
      .reverse()
      .map((m) => ({
        id: String(m.id),
        text: m.text,
        label: m.label,
        userId: m.user_id,
        media: m.media,
      }))
      .filter((m) => m.text);
    download(`watchtower-messages-${new Date().toISOString().slice(0, 10)}.json`, {
      version: 1,
      chatId: data?.chatId,
      exportedAt: new Date().toISOString(),
      messages,
      examples,
    });
    return messages.length;
  }
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <a className="brand" href="#overview" onClick={() => navigate('overview')}>
          <span className="brand-mark">
            <ShieldCheck size={25} strokeWidth={1.7} />
          </span>
          <span>
            watchtower<span className="brand-period">.</span>
          </span>
        </a>
        <GroupSwitcher current={group} groups={groups} onSelect={onSelect} onManage={onManage} />
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {pages.slice(0, 3).map((p) => (
            <button
              key={p.id}
              className={page === p.id ? 'active' : ''}
              onClick={() => navigate(p.id)}
            >
              <p.icon size={18} />
              <span>{p.title}</span>
              {p.id === 'messages' && Boolean(data?.stats.review) && (
                <span className="nav-count">{data!.stats.review}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label second">CONFIGURATION</div>
        <nav>
          {pages.slice(3).map((p) => (
            <button
              key={p.id}
              className={page === p.id ? 'active' : ''}
              onClick={() => navigate(p.id)}
            >
              <p.icon size={18} />
              <span>{p.title}</span>
              {p.id === 'lab' && <span className="new-label">LAB</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="edge-card">
            <span>
              <Zap size={15} /> BUILT FOR THE EDGE
            </span>
            <p>
              A quieter group.
              <br />A healthier community.
            </p>
            <div>
              <i /> Cloudflare Workers
            </div>
          </div>
          <button className="help-link" onClick={() => setSetup(true)}>
            <CircleHelp size={17} /> Setup & documentation <ArrowUpRight size={15} />
          </button>
          <div className="owner">
            <div className="owner-avatar">
              {data?.dev ? 'L' : (data?.owner[0] || 'O').toUpperCase()}
            </div>
            <div>
              <strong>{data?.dev ? 'Local owner' : data?.owner || 'Workspace owner'}</strong>
              <span>
                <LockKeyhole size={10} /> Private admin workspace
              </span>
            </div>
            <Shield size={15} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        {group.status !== 'active' && (
          <div className="group-disconnected alert">
            This group needs to be reconnected before moderation can resume.
            <button className="text-button" onClick={onManage}>
              Manage groups
            </button>
          </div>
        )}
        <header className="topbar">
          <div>
            <button
              className="mobile-menu icon-button"
              onClick={() => setMobileNav(!mobileNav)}
              aria-label="Toggle navigation"
            >
              <LayoutDashboard size={19} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{pages.find((p) => p.id === page)?.title || 'Overview'}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${modelReady ? 'ready' : ''}`}>
              <i />
              {modelReady ? 'Provider connected' : 'Setup pending'}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              onClick={() => navigate('messages')}
              aria-label="Review messages"
            >
              <Bell size={18} />
              {Boolean(data?.stats.review) && <i className="notification-dot" />}
            </button>
            <div className="mini-avatar">
              {data?.dev ? 'L' : (data?.owner[0] || 'O').toUpperCase()}
            </div>
          </div>
        </header>
        <main>
          {storageWaiting && (
            <div className="alert">
              <AlertCircle size={18} />
              <span>
                PlanetScale setup is incomplete. Finish database setup to enable moderation and
                Settings.
              </span>
            </div>
          )}
          {data?.dev && (
            <div className="local-banner">
              <FlaskConical size={14} />
              <span>
                Local workspace <b>·</b> Connect your credentials to see live activity. Starter
                examples are for testing only.
              </span>
              <button onClick={() => setSetup(true)}>
                Setup guide <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {error && (
            <div className="alert">
              <AlertCircle size={18} />
              {error}
              <button onClick={() => void reload().catch(() => {})}>Retry</button>
            </div>
          )}
          {!data && !error && (
            <div className="loading">
              <LoaderCircle className="spin" /> Loading your workspace…
            </div>
          )}
          {data && (
            <>
              {page === 'overview' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">
                        <span className="tiny-line" /> COMMUNITY HEALTH
                      </div>
                      <h1>A little less noise.</h1>
                      <p>Keep the conversation going. We’ll keep an eye on the spam.</p>
                    </div>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void act(exportMessages, 'Captured messages exported.')}
                    >
                      <ArrowDownToLine size={16} /> Export messages
                    </button>
                  </div>
                  <div className="protection-banner">
                    <div className="protection-symbol">
                      <ShieldCheck size={27} />
                    </div>
                    <div>
                      <h3>
                        {mode === 'enforce'
                          ? 'Your community is protected'
                          : mode === 'paused'
                            ? 'Moderation is paused'
                            : 'Watching, learning, getting ready'}
                      </h3>
                      <p>
                        {mode === 'enforce'
                          ? 'Three-strike moderation is active. New messages are checked on the minute schedule.'
                          : mode === 'paused'
                            ? 'New messages are captured. Classification and moderation are on hold.'
                            : 'Observation mode records classifications. Enable enforcement when you’re happy with the results.'}
                      </p>
                    </div>
                    <button className={`mode-pill ${mode}`} onClick={() => navigate('settings')}>
                      <span />
                      {mode === 'enforce'
                        ? 'Enforcement on'
                        : mode === 'observe'
                          ? 'Observation mode'
                          : 'Paused'}
                      <ChevronDown size={13} />
                    </button>
                  </div>
                  <div className="stats-grid">
                    {[
                      {
                        label: 'Messages monitored',
                        value: data.stats.total,
                        icon: MessageSquare,
                        note: 'In your retained message history',
                        className: '',
                      },
                      {
                        label: 'Spam detected',
                        value: data.stats.spam,
                        icon: Shield,
                        note: data.stats.total
                          ? `${percent(data.stats.spam / data.stats.total)} of monitored messages`
                          : 'Ready for your first messages',
                        className: 'spam-stat',
                      },
                      {
                        label: 'Messages deleted',
                        value: data.stats.deleted,
                        icon: Trash2,
                        note: 'Confirmed Telegram deletions',
                        className: '',
                      },
                      {
                        label: 'Users banned',
                        value: data.stats.banned,
                        icon: Users,
                        note: 'After their third spam strike',
                        className: '',
                      },
                    ].map((s) => (
                      <div className={`stat-card ${s.className}`} key={s.label}>
                        <div>
                          <span>{s.label}</span>
                          <s.icon size={17} />
                        </div>
                        <strong>{number(s.value)}</strong>
                        <small>{s.note}</small>
                      </div>
                    ))}
                  </div>
                  <div className="overview-columns">
                    <section className="panel activity-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Message activity</h2>
                          <p>A pulse check on your community.</p>
                        </div>
                        <span className="period">
                          <Clock3 size={13} /> Last 7 days
                        </span>
                      </div>
                      <ActivityChart daily={data.daily} />
                      <div className="chart-footer">
                        <span>
                          <i className="legend-dot all" /> All messages
                        </span>
                        <span>
                          <i className="legend-dot spam" /> Spam detected
                        </span>
                        <span className="chart-note">UTC · retained history</span>
                      </div>
                    </section>
                    <section className="panel policy-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Three strikes. Clear boundaries.</h2>
                          <p>A fair escalation for repeat spam.</p>
                        </div>
                        <ShieldCheck size={19} className="muted" />
                      </div>
                      <div className="strike-steps">
                        {[
                          {
                            n: 1,
                            title: 'Delete & record',
                            text: 'Spam is removed. A strike is logged.',
                          },
                          {
                            n: 2,
                            title: 'Clear their messages',
                            text: 'Purge tracked messages under 48 hours.',
                          },
                          {
                            n: 3,
                            title: 'Ban from the group',
                            text: 'Remove the user. Revoke their history.',
                          },
                        ].map((s) => (
                          <div className={`strike-step step-${s.n}`} key={s.n}>
                            <span>{s.n}</span>
                            <div>
                              <strong>{s.title}</strong>
                              <p>{s.text}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="policy-footer">
                        <span>
                          <LockKeyhole size={13} /> Owner & admins are exempt
                        </span>
                        <button onClick={() => navigate('settings')}>
                          View policy <ArrowRight size={14} />
                        </button>
                      </div>
                    </section>
                  </div>
                  <section className="panel feed-panel">
                    <div className="panel-heading">
                      <div className="heading-inline">
                        <h2>Recent messages</h2>
                        <span className="live-dot" />
                        <span className="subtle">Updates every 30 seconds</span>
                      </div>
                      <button className="text-button" onClick={() => navigate('messages')}>
                        View all messages <ArrowRight size={15} />
                      </button>
                    </div>
                    <MessageTable
                      messages={data.messages.slice(0, 5)}
                      onSelect={setDetail}
                      emptyText="Messages will appear here as your bot receives them."
                    />
                  </section>
                  <div className="lab-callout">
                    <div className="lab-callout-icon">
                      <FlaskConical size={22} />
                    </div>
                    <div>
                      <h3>Find the right model for your community.</h3>
                      <p>
                        Compare Gemini, Jev, and more on your own messages. Tune your threshold with
                        confidence.
                      </p>
                    </div>
                    <button className="button secondary" onClick={() => navigate('lab')}>
                      Open model lab <ArrowUpRight size={16} />
                    </button>
                  </div>
                </>
              )}
              {page === 'messages' && (
                <MessageFeed
                  data={data}
                  onSelect={setDetail}
                  onExport={() => void act(exportMessages, 'Captured messages exported.')}
                />
              )}
              {page === 'users' && (
                <>
                  <PageHeading
                    eyebrow="MODERATION"
                    title="A fair record."
                    subtitle="Persistent strikes, keyed by Telegram user. Every action has a history."
                  />
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Users with strikes</h2>
                      <span className="subtle">{data.users.length} tracked users</span>
                    </div>
                    {data.users.length ? (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>User</th>
                              <th>Strikes</th>
                              <th>Status</th>
                              <th>Last seen</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {data.users.map((u) => (
                              <tr key={u.user_id}>
                                <td>
                                  <div className="user-cell">
                                    <Avatar name={u.name} id={u.user_id} />
                                    <div>
                                      <strong>{u.name}</strong>
                                      <small>{u.user_id}</small>
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <div className="strike-dots">
                                    {[1, 2, 3].map((i) => (
                                      <span className={u.strikes >= i ? 'filled' : ''} key={i} />
                                    ))}
                                    <span>{u.strikes} / 3</span>
                                  </div>
                                </td>
                                <td>
                                  <Badge
                                    status={
                                      u.banned ? 'banned' : u.strikes >= 3 ? 'ban queued' : 'active'
                                    }
                                  />
                                </td>
                                <td className="muted">
                                  {new Date(u.last_seen).toLocaleDateString()}
                                </td>
                                <td>
                                  <button
                                    className="text-button"
                                    disabled={busy}
                                    onClick={() =>
                                      void act(
                                        () =>
                                          api(`/users/${u.user_id}/reset`, {
                                            method: 'POST',
                                            body: '{}',
                                          }),
                                        'Strikes reset; bot ban lifted if present.',
                                      )
                                    }
                                  >
                                    Reset{u.banned ? ' & unban' : ''}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty icon={Users} title="A clean slate">
                        No strikes have been recorded. Observation mode never awards strikes.
                      </Empty>
                    )}
                  </section>
                  <section className="panel audit-panel">
                    <div className="panel-heading">
                      <h2>Action log</h2>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () => api('/actions/retry', { method: 'POST', body: '{}' }),
                            'Failed actions queued for retry.',
                          )
                        }
                      >
                        <RefreshCw size={14} /> Retry failed actions
                      </button>
                    </div>
                    {data.audit.length ? (
                      <div className="audit-list">
                        {data.audit.map((a) => (
                          <div key={a.id}>
                            <span className="audit-symbol">
                              <Activity size={16} />
                            </span>
                            <div>
                              <strong>{a.kind.replaceAll('_', ' ')}</strong>
                              <p>{auditDetail(a.detail)}</p>
                              {a.user_id && (
                                <small>
                                  User {a.user_id}
                                  {a.message_id ? ` · Message ${a.message_id}` : ''}
                                </small>
                              )}
                            </div>
                            <time>{time(a.created_at)}</time>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty icon={Activity} title="Your audit trail starts here">
                        Spam decisions, deletions, bans, and configuration changes are recorded
                        here.
                      </Empty>
                    )}
                  </section>
                </>
              )}
              {page === 'lab' && <ModelLab data={data} act={act} />}
              {page === 'settings' &&
                (storageWaiting ? (
                  <Empty icon={Settings2} title="Finish database setup">
                    Initialize the PlanetScale database to configure live moderation.
                  </Empty>
                ) : (
                  <SettingsPage data={data} act={act} busy={busy} />
                ))}
            </>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={13} /> watchtower <span>·</span> Thoughtful moderation, at the
              edge.
            </span>
            <span>
              <LockKeyhole size={12} /> Owner access only
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          {toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.text}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Message details"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>Message details</h2>
              <button
                className="icon-button"
                aria-label="Close message details"
                onClick={() => setDetail(null)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="detail-user">
              <Avatar name={detail.user_name} id={detail.user_id} />
              <div>
                <strong>{detail.user_name}</strong>
                <small>
                  User {detail.user_id} · Message {detail.id}
                </small>
              </div>
              <Badge status={detail.status} />
            </div>
            <blockquote>{detail.text || `[${detail.media} without a caption]`}</blockquote>
            <dl>
              <div>
                <dt>Spam score</dt>
                <dd>{detail.score === null ? 'Not classified' : percent(detail.score)}</dd>
              </div>
              <div>
                <dt>Decision</dt>
                <dd>{detail.reason || 'No decision yet.'}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{detail.model || '—'}</dd>
              </div>
              <div>
                <dt>Action</dt>
                <dd>
                  {detail.deleted
                    ? 'Deleted'
                    : detail.strike_awarded
                      ? 'Strike recorded; check action log for deletion status'
                      : 'No enforcement action'}
                </dd>
              </div>
            </dl>
            <label className="field">
              Ground truth label
              <select
                aria-label="Message ground truth"
                value={detail.label || ''}
                onChange={(e) => {
                  const label = (e.target.value || null) as Label;
                  void act(async () => {
                    await api(`/messages/${detail.id}/label`, {
                      method: 'POST',
                      body: JSON.stringify({ label }),
                    });
                    setDetail({ ...detail, label });
                  }, 'Label saved.');
                }}
              >
                <option value="">Unlabelled</option>
                <option value="ham">Legitimate</option>
                <option value="spam">Spam</option>
              </select>
            </label>
            <div className="modal-actions">
              <button
                className="button secondary"
                disabled={
                  busy ||
                  Boolean(detail.strike_awarded || detail.deleted) ||
                  detail.status === 'protected'
                }
                onClick={() =>
                  void act(
                    () => api(`/messages/${detail.id}/retry`, { method: 'POST', body: '{}' }),
                    'Message queued for reclassification.',
                  )
                }
              >
                <RefreshCw size={15} /> Recheck
              </button>
              <button
                className="button danger"
                disabled={
                  busy ||
                  mode !== 'enforce' ||
                  Boolean(detail.strike_awarded) ||
                  detail.status === 'protected'
                }
                onClick={() =>
                  void act(async () => {
                    await api(`/messages/${detail.id}/moderate`, { method: 'POST', body: '{}' });
                    setDetail(null);
                  }, 'Spam recorded. Deletion queued.')
                }
              >
                <Trash2 size={15} /> Delete + add strike
              </button>
            </div>
            {mode !== 'enforce' && (
              <p className="field-help">Enable enforcement in Settings to apply a manual strike.</p>
            )}
          </section>
        </div>
      )}
      {setup && (
        <div className="modal-backdrop" onClick={() => setSetup(false)}>
          <section
            className="modal setup-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Setup guide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">GET CONNECTED</span>
                <h2>Your watchtower, online.</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close setup guide"
                onClick={() => setSetup(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="setup-note">
              <Plus size={17} />
              <p>
                Connecting another community? Use the group menu in the sidebar → Add or manage
                groups. Add the same bot, grant Delete messages and Ban users, then activate it in
                Observe. You can copy this group’s settings.
              </p>
              <button
                className="text-button"
                onClick={() => {
                  setSetup(false);
                  onManage();
                }}
              >
                Manage groups
              </button>
            </div>
            <ol className="setup-steps">
              <li>
                <strong>Create your Telegram bot</strong>
                <p>
                  Use @BotFather, then add the bot to your supergroup as an administrator with
                  Delete messages and Ban users permissions.
                </p>
              </li>
              <li>
                <strong>Connect your credentials</strong>
                <p>
                  Add the Telegram token, webhook secret, and model API key using Wrangler secrets.
                  Set your group ID and owner ID in wrangler.jsonc.
                </p>
              </li>
              <li>
                <strong>Keep the dashboard private</strong>
                <p>
                  Create a Cloudflare Access app for your dashboard hostname, allowing only your
                  email. Configure the team domain, audience, and owner email. Exclude
                  /telegram/webhook from Access.
                </p>
              </li>
              <li>
                <strong>Deploy and register the webhook</strong>
                <code>
                  npm run deploy
                  <br />
                  npm run telegram:setup
                </code>
                <p>
                  The setup script reads credentials from your environment and checks the bot’s
                  permissions.
                </p>
              </li>
              <li>
                <strong>Observe, tune, enable</strong>
                <p>
                  Import a Telegram Desktop JSON export into Model lab. Label a representative
                  sample, compare models, and enable enforcement when ready.
                </p>
              </li>
            </ol>
            <div className="setup-note">
              <CircleHelp size={17} />
              <p>
                Telegram’s “Report Spam” checkbox is unavailable to bots. Watchtower records spam
                internally. Strike two purges tracked messages under 48 hours; strike three bans
                with history revocation.
              </p>
            </div>
            <p className="field-help">
              Full deployment steps and architecture notes are in this project’s README.md.
            </p>
            <a
              className="text-button"
              href="https://telegram.org/blog/export-and-more"
              target="_blank"
              rel="noreferrer"
            >
              Telegram’s export guide <ExternalLink size={14} />
            </a>
          </section>
        </div>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">
          <span className="tiny-line" />
          {eyebrow}
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
function ActivityChart({ daily }: { daily: Overview['daily'] }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - i));
    const key = date.toISOString().slice(0, 10);
    const counts = daily.find((d) => d.day === key);
    return {
      day: date.toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }),
      total: counts?.total || 0,
      spam: counts?.spam || 0,
    };
  });
  const max = Math.max(4, ...days.map((d) => d.total));
  return (
    <div className="activity-chart">
      <div className="chart-y">
        {[max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0].map(
          (n, i) => (
            <span key={i}>{number(n)}</span>
          ),
        )}
      </div>
      <div className="bars-area">
        <div className="grid-lines">
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} />
          ))}
        </div>
        {days.map((d, i) => (
          <div className="day-bar" key={i} title={`${d.day}: ${d.total} messages, ${d.spam} spam`}>
            <div className="bars">
              <div
                className="bar all"
                style={{ height: `${Math.max(d.total ? 2 : 0, (d.total / max) * 100)}%` }}
              />
              <div
                className="bar spam"
                style={{ height: `${Math.max(d.spam ? 2 : 0, (d.spam / max) * 100)}%` }}
              />
            </div>
            <span>{d.day}</span>
          </div>
        ))}
        {!daily.length && (
          <div className="chart-empty-label">
            <Activity size={16} /> Waiting for live activity
          </div>
        )}
      </div>
    </div>
  );
}
function MessageTable({
  messages,
  onSelect,
  emptyText,
}: {
  messages: StoredMessage[];
  onSelect: (m: StoredMessage) => void;
  emptyText?: string;
}) {
  if (!messages.length)
    return (
      <Empty title="The conversation starts here">
        {emptyText || 'No messages match your filters.'}
      </Empty>
    );
  return (
    <div className="table-scroll">
      <table className="message-table">
        <thead>
          <tr>
            <th>Sender</th>
            <th>Message</th>
            <th>Spam score</th>
            <th>Status</th>
            <th>Time</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.id} onClick={() => onSelect(m)}>
              <td>
                <div className="user-cell">
                  <Avatar name={m.user_name} id={m.user_id} />
                  <strong>{m.user_name}</strong>
                </div>
              </td>
              <td>
                <div className="message-preview">{m.text || `[${m.media} without caption]`}</div>
                {Boolean(m.deleted) && (
                  <small className="deleted-note">
                    <Trash2 size={10} /> Deleted
                  </small>
                )}
              </td>
              <td>
                <span className={`score ${m.score !== null && m.score >= 0.9 ? 'high' : ''}`}>
                  {m.score === null ? '—' : percent(m.score)}
                </span>
              </td>
              <td>
                <Badge status={m.status} />
              </td>
              <td className="time-cell">{time(m.sent_at)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Inspect message ${m.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(m);
                  }}
                >
                  <MoreHorizontal size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function MessageFeed({
  data,
  onSelect,
  onExport,
}: {
  data: Overview;
  onSelect: (m: StoredMessage) => void;
  onExport: () => void;
}) {
  const api = useMemo(() => apiForGroup(data.chatId), [data.chatId]);
  const [search, setSearch] = useState(''),
    [searchQuery, setSearchQuery] = useState(''),
    [filter, setFilter] = useState(''),
    [offset, setOffset] = useState(0);
  const [messages, setMessages] = useState<StoredMessage[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(async () => {
    const result = await api<{ messages: StoredMessage[]; total: number }>(
      `/messages?limit=30&offset=${offset}&status=${encodeURIComponent(filter)}&search=${encodeURIComponent(searchQuery)}`,
    );
    setMessages(result.messages);
    setTotal(result.total);
    setError('');
  }, [api, filter, searchQuery, offset, data.stats.total, data.stats.deleted]);
  useVisiblePoll(load, 30_000, (e) => setError(e.message));
  return (
    <>
      <PageHeading
        eyebrow="LIVE MODERATION"
        title="Every message, in view."
        subtitle="Inspect decisions, label examples, and keep the context behind each action."
      >
        <button className="button secondary" onClick={onExport}>
          <ArrowDownToLine size={16} /> Export messages
        </button>
      </PageHeading>
      <div className="feed-toolbar">
        <div className="filter-tabs">
          {[
            ['', 'All messages'],
            ['spam', 'Spam'],
            ['observed_spam', 'Would flag'],
            ['review', 'Review'],
            ['error', 'Errors'],
          ].map(([value, title]) => (
            <button
              className={filter === value ? 'active' : ''}
              key={value}
              onClick={() => {
                setFilter(value);
                setOffset(0);
              }}
            >
              {title}
            </button>
          ))}
        </div>
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search messages"
            placeholder="Search messages or senders…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      <section className="panel">
        <MessageTable messages={messages} onSelect={onSelect} />
        <div className="pagination">
          <span>
            {total
              ? `${offset + 1}–${Math.min(offset + 30, total)} of ${number(total)} messages`
              : '0 messages'}
          </span>
          <div>
            <button
              className="icon-button"
              aria-label="Previous message page"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 30))}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Next message page"
              disabled={offset + 30 >= total}
              onClick={() => setOffset(offset + 30)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
function auditDetail(detail: string) {
  try {
    const value = JSON.parse(detail);
    return (
      value.reason ||
      (value.mode ? `Configuration saved · ${value.mode} mode · ${value.model}` : detail)
    );
  } catch {
    return detail;
  }
}

type Act = (fn: () => Promise<unknown>, success?: string) => Promise<void>;
function ModelLab({ data, act }: { data: Overview; act: Act }) {
  const api = useMemo(() => apiForGroup(data.chatId), [data.chatId]);
  const retryApi = api.retry;
  const [datasets, setDatasets] = useState<Dataset[]>([]),
    [selected, setSelected] = useState(''),
    [examples, setExamples] = useState<Example[]>([]);
  const [runs, setRuns] = useState<Evaluation[]>([]),
    [threshold, setThreshold] = useState(data.settings.threshold),
    [labelPage, setLabelPage] = useState(0);
  const [models, setModels] = useState([
    { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite' },
    { provider: 'jev', model: 'typesafe/jev-1.13' },
  ]);
  const [policy, setPolicy] = useState(data.settings.policy),
    [sample, setSample] = useState(200),
    [showPolicy, setShowPolicy] = useState(false),
    [runSelected, setRunSelected] = useState('');
  const [tab, setTab] = useState<'compare' | 'dataset'>('compare'),
    [error, setError] = useState(''),
    [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const importAbort = useRef<AbortController | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [exporting, setExporting] = useState(false);
  const [labelEdits] = useState(() => new LabelEdits());
  const [evaluationReader] = useState(() => new EvaluationReader(api));
  const [savingLabels, setSavingLabels] = useState<ReadonlySet<string>>(new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => () => importAbort.current?.abort(), []);
  const load = useCallback(async () => {
    const labelVersion = labelEdits.snapshot();
    await Promise.all([
      api<Dataset[]>('/datasets').then((ds) => {
        setDatasets((current) => labelEdits.datasets(ds, current, labelVersion));
        setSelected((value) => value || ds[0]?.id || '');
      }),
      evaluationReader
        .load((run) => {
          setRuns((current) =>
            [
              ...current.filter((r) => r.id !== run.id),
              ...labelEdits.runs([run], labelVersion),
            ].sort((a, b) => b.created_at - a.created_at),
          );
        })
        .then((rs) => {
          setRuns(labelEdits.runs(rs, labelVersion));
        }),
    ]);
    setError('');
  }, [labelEdits, evaluationReader]);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const refresh = useCallback(async () => {
    const previous = runsRef.current;
    if (!previous.some((r) => r.status === 'queued' || r.status === 'running')) {
      await load();
      return;
    }
    const statuses =
      await api<Omit<Evaluation, 'examples' | 'predictions' | 'reviewLabels'>[]>(
        '/evaluations/status',
      );
    const changed =
      statuses.length !== previous.length ||
      statuses.some((r) => {
        const old = previous.find((p) => p.id === r.id);
        return !old || (old.status !== r.status && !['queued', 'running'].includes(r.status));
      });
    if (changed) await load();
    else {
      const byId = new Map(statuses.map((r) => [r.id, r]));
      setRuns((runs) => runs.map((r) => ({ ...r, ...byId.get(r.id) })));
      setError('');
    }
  }, [load]);
  useEffect(() => {
    setLabelPage(0);
  }, [selected]);
  const activeRuns = runs.some((r) => r.status === 'queued' || r.status === 'running');
  useVisiblePoll(refresh, activeRuns ? 5000 : null, (e) => setError(e.message));
  useEffect(() => {
    if (!selected) {
      setExamples([]);
      return;
    }
    let active = true;
    const labelVersion = labelEdits.snapshot();
    setExamples([]);
    api<{ examples: Example[] }>(`/datasets/${selected}?offset=${labelPage * 25}&limit=25`)
      .then((v) => {
        if (active) setExamples(labelEdits.examples(selected, v.examples, labelVersion));
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [selected, labelPage, labelEdits]);
  async function saveLabel(datasetId: string, example: Example, label: Label, runId?: string) {
    if (!labelEdits.begin(datasetId, example.id)) return;
    setSavingLabels(new Set(labelEdits.pending));
    try {
      await api(runId ? `/evaluations/${runId}/reviews` : `/datasets/${datasetId}/labels`, {
        method: 'POST',
        body: JSON.stringify([{ id: example.id, label }]),
      });
      const edit: LabelEdit = { datasetId, example, label, updatedAt: Date.now() };
      labelEdits.commit(edit);
      setRuns((current) => applyReviewLabel(current, edit));
      if (selectedRef.current === datasetId)
        setExamples((current) =>
          current.map((e) => (sameExample(e, example) ? { ...e, label } : e)),
        );
      setDatasets((current) =>
        current.map((d) =>
          d.id === datasetId
            ? {
                ...d,
                labelled: d.labelled + Number(label !== null) - Number(example.label !== null),
              }
            : d,
        ),
      );
    } catch (e) {
      setError(
        `Could not confirm the label for message #${example.id}: ${e instanceof Error ? e.message : 'Please retry.'}`,
      );
    } finally {
      labelEdits.end(datasetId, example.id);
      setSavingLabels(new Set(labelEdits.pending));
    }
  }
  const selectedRuns = runs.filter((r) => r.dataset_id === selected);
  const displayRun =
    selectedRuns.find((r) => r.id === runSelected) ||
    selectedRuns.find((r) => r.predictions.length > 0) ||
    selectedRuns[0];
  const selectedDataset = datasets.find((d) => d.id === selected);
  const exampleCount = selectedDataset?.count || 0;
  const labelled = selectedDataset?.labelled || 0;
  const falsePositives =
    (displayRun ? reviewedExamples(displayRun) : []).filter(
      (e) =>
        e.label === 'ham' &&
        displayRun.predictions.some((p) => p.id === e.id && p.score >= threshold),
    ) || [];
  async function importFile(file?: File) {
    if (!file || importAbort.current) return;
    setError('');
    const controller = new AbortController(),
      id = crypto.randomUUID();
    importAbort.current = controller;
    setImportProgress({ bytes: 0, totalBytes: file.size, messages: 0 });
    let complete = false;
    try {
      await retryApi(
        '/datasets/imports',
        {
          method: 'POST',
          body: JSON.stringify({
            id,
            name: file.name.replace(/\.json$/i, '').slice(0, 100) || 'Imported messages',
          }),
        },
        controller.signal,
      );
      const result = await streamExamples(
        file,
        async (examples, sequence) => {
          await retryApi(
            `/datasets/${id}/chunks`,
            { method: 'POST', body: JSON.stringify({ sequence, examples }) },
            controller.signal,
          );
        },
        setImportProgress,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      await retryApi(
        `/datasets/${id}/complete`,
        { method: 'POST', body: JSON.stringify(result) },
        controller.signal,
      );
      complete = true;
      await load();
      setSelected(id);
      setTab('dataset');
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Import failed. Please retry.');
    } finally {
      if (!complete) await api(`/datasets/${id}`, { method: 'DELETE' }).catch(() => {});
      importAbort.current = null;
      setImportProgress(null);
    }
  }
  async function exportDataset() {
    if (!selected || exporting) return;
    setExporting(true);
    await act(async () => {
      const parts: BlobPart[] = ['{"version":1,"examples":['];
      let offset: number | null = 0,
        first = true;
      while (offset !== null) {
        const page: { examples: Example[]; nextOffset: number | null } = await api(
          `/datasets/${selected}?offset=${offset}&limit=250`,
        );
        const text = page.examples.map((e) => JSON.stringify(e)).join(',');
        if (text) {
          parts.push(`${first ? '' : ','}${text}`);
          first = false;
        }
        offset = page.nextOffset;
      }
      parts.push(']}');
      downloadBlob('watchtower-dataset.json', new Blob(parts, { type: 'application/json' }));
    }, 'Dataset exported.').finally(() => setExporting(false));
  }
  return (
    <>
      <PageHeading
        eyebrow="EXPERIMENT, THEN ENFORCE"
        title="A better signal."
        subtitle="Your messages. Your policy. Find the model that gets your community."
      >
        <button
          className="button secondary"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={16} /> Refresh results
        </button>
        <button
          className="button secondary"
          disabled={Boolean(importProgress)}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={16} /> Import messages
        </button>
      </PageHeading>
      <input
        className="hidden"
        type="file"
        accept=".json,application/json"
        ref={fileRef}
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && (
        <div className="alert">
          <AlertCircle size={16} />
          {error}
          <button onClick={() => setError('')} aria-label="Dismiss lab error">
            <X size={16} />
          </button>
        </div>
      )}
      {importProgress && (
        <section className="import-progress" aria-live="polite">
          <div>
            <LoaderCircle size={17} className="spin" />
            <span>Importing messages</span>
            <button className="text-button" onClick={() => importAbort.current?.abort()}>
              Cancel import
            </button>
          </div>
          <progress value={importProgress.bytes} max={Math.max(1, importProgress.totalBytes)} />
          <p>
            {((importProgress.bytes / Math.max(1, importProgress.totalBytes)) * 100).toFixed(0)}%
            read · {number(importProgress.messages)} text messages ·{' '}
            {importProgress.bytes === importProgress.totalBytes
              ? 'Finishing upload…'
              : 'Uploading automatically in batches'}
          </p>
        </section>
      )}
      <div className="lab-tabs">
        <button className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>
          <FlaskConical size={16} /> Model comparison
        </button>
        <button className={tab === 'dataset' ? 'active' : ''} onClick={() => setTab('dataset')}>
          <FileJson size={16} /> Datasets & labels<span>{datasets.length}</span>
        </button>
      </div>
      {!datasets.length ? (
        <section
          className="panel import-panel"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void importFile(e.dataTransfer.files[0]);
          }}
        >
          <span className="import-illustration">
            <FileJson size={40} strokeWidth={1.3} />
            <span>
              <Plus size={16} />
            </span>
          </span>
          <h2>Start with a real conversation.</h2>
          <p>
            Export your group from Telegram Desktop as JSON.
            <br />
            Wait for the export to finish, then drop the JSON file here or choose it below.
          </p>
          <button
            className="button primary"
            disabled={Boolean(importProgress)}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={16} /> Choose JSON file
          </button>
          <div className="import-alternatives">
            <button
              className="text-button"
              onClick={() =>
                void act(async () => {
                  const result = await api<{ id: string }>('/datasets/capture', {
                    method: 'POST',
                    body: JSON.stringify({ name: 'Captured community messages' }),
                  });
                  await load();
                  setSelected(result.id);
                }, 'Captured messages added to a dataset.')
              }
            >
              Use captured messages
            </button>
            {data.dev && (
              <>
                <span>or</span>
                <button
                  className="text-button"
                  onClick={() =>
                    void act(async () => {
                      const result = await api<{ id: string }>('/demo', {
                        method: 'POST',
                        body: '{}',
                      });
                      await load();
                      setSelected(result.id);
                    }, 'Illustrative starter dataset added. No model calls have been made.')
                  }
                >
                  Try starter examples <ArrowRight size={14} />
                </button>
              </>
            )}
          </div>
          <small>Text and captions only · large exports upload automatically in batches</small>
        </section>
      ) : (
        <>
          <div className="dataset-toolbar">
            <div>
              <span className="dataset-label">DATASET</span>
              <select
                aria-label="Active dataset"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <span className="subtle">
                {number(exampleCount)} messages <span className="separator">·</span> {labelled}{' '}
                labelled
              </span>
            </div>
            <button
              className="text-button"
              disabled={exporting}
              onClick={() => void exportDataset()}
            >
              <ArrowDownToLine size={14} /> {exporting ? 'Exporting…' : 'Export dataset'}
            </button>
          </div>
          {tab === 'dataset' ? (
            <>
              <div className="lab-info">
                <CircleHelp size={17} />
                <p>
                  Labels are your ground truth. Model scores never become labels automatically.
                  Saved runs keep a snapshot of the labels and prompt used at the time.
                </p>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Teach the lab what spam looks like</h2>
                  <div className="label-progress">
                    <span>
                      {labelled} / {exampleCount} labelled
                    </span>
                    <div>
                      <i
                        style={{
                          width: `${exampleCount ? (labelled / exampleCount) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="dataset-rows">
                  {examples.map((e) => (
                    <div key={e.id}>
                      <span className="example-id">#{e.id}</span>
                      <div>
                        <p>{e.text}</p>
                        {Boolean(e.context?.length) && (
                          <details>
                            <summary>{e.context!.length} recent messages from this sender</summary>
                            {e.context!.map((c, i) => (
                              <blockquote key={i}>{c}</blockquote>
                            ))}
                          </details>
                        )}
                      </div>
                      <div className="label-buttons">
                        <button
                          className={e.label === 'ham' ? 'selected ham' : ''}
                          aria-label={`Label message ${e.id} legitimate`}
                          aria-pressed={e.label === 'ham'}
                          disabled={savingLabels.has(labelKey(selected, e.id))}
                          onClick={() =>
                            void saveLabel(selected, e, e.label === 'ham' ? null : 'ham')
                          }
                        >
                          <Check size={14} /> Legitimate
                        </button>
                        <button
                          className={e.label === 'spam' ? 'selected spam' : ''}
                          aria-label={`Label message ${e.id} spam`}
                          aria-pressed={e.label === 'spam'}
                          disabled={savingLabels.has(labelKey(selected, e.id))}
                          onClick={() =>
                            void saveLabel(selected, e, e.label === 'spam' ? null : 'spam')
                          }
                        >
                          <Shield size={14} /> Spam
                        </button>
                        {savingLabels.has(labelKey(selected, e.id)) && (
                          <LoaderCircle
                            size={13}
                            className="spin"
                            aria-label={`Saving label for message ${e.id}`}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="pagination">
                  <span>
                    Labels update saved-score metrics. Re-run only to test a new model or prompt.
                  </span>
                  <div>
                    <button
                      className="icon-button"
                      aria-label="Previous label page"
                      disabled={!labelPage}
                      onClick={() => setLabelPage(labelPage - 1)}
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <span>
                      {labelPage + 1} / {Math.max(1, Math.ceil(exampleCount / 25))}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Next label page"
                      disabled={(labelPage + 1) * 25 >= exampleCount}
                      onClick={() => setLabelPage(labelPage + 1)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                </div>
              </section>
              <div className="dataset-bottom-actions">
                <button
                  className="text-button"
                  onClick={() =>
                    void act(async () => {
                      const result = await api<{ id: string }>('/datasets/capture', {
                        method: 'POST',
                        body: JSON.stringify({
                          name: `Captured messages · ${new Date().toLocaleDateString()}`,
                        }),
                      });
                      await load();
                      setSelected(result.id);
                    }, 'Captured dataset created.')
                  }
                >
                  <Plus size={14} /> New dataset from live messages
                </button>
                <button
                  className="text-button red"
                  onClick={() =>
                    void act(async () => {
                      await api(`/datasets/${selected}`, { method: 'DELETE' });
                      setSelected('');
                      await load();
                    }, 'Dataset deleted. Existing evaluation snapshots are retained.')
                  }
                >
                  <Trash2 size={14} /> Delete dataset
                </button>
              </div>
            </>
          ) : (
            <>
              <section className="panel comparison-config">
                <div className="panel-heading">
                  <div>
                    <h2>Pick your contenders</h2>
                    <p>Same messages, same policy. An even comparison.</p>
                  </div>
                  <span className="tag">Up to 5 models</span>
                </div>
                <div className="model-inputs">
                  {models.map((m, i) => (
                    <div className="model-input-row" key={i}>
                      <span className={`model-number color-${i}`}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <select
                        aria-label={`Model ${i + 1} provider`}
                        value={m.provider}
                        onChange={(e) =>
                          setModels((ms) =>
                            ms.map((v, j) =>
                              j === i
                                ? {
                                    provider: e.target.value,
                                    model:
                                      e.target.value === 'jev'
                                        ? 'typesafe/jev-1.13'
                                        : 'google/gemini-2.5-flash-lite',
                                  }
                                : v,
                            ),
                          )
                        }
                      >
                        {data.providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.configured ? '' : ' · key needed'}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`Model ${i + 1} ID`}
                        value={m.model}
                        onChange={(e) =>
                          setModels((ms) =>
                            ms.map((v, j) => (j === i ? { ...v, model: e.target.value } : v)),
                          )
                        }
                        placeholder="Provider model ID"
                      />
                      <button
                        className="icon-button"
                        aria-label={`Remove model ${i + 1}`}
                        disabled={models.length <= 1}
                        onClick={() => setModels((ms) => ms.filter((_, j) => i !== j))}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="comparison-controls">
                  <div>
                    <button
                      className="text-button"
                      disabled={models.length >= 5}
                      onClick={() =>
                        setModels((ms) => [...ms, { provider: 'openrouter', model: '' }])
                      }
                    >
                      <Plus size={14} /> Add model
                    </button>
                    <button className="text-button" onClick={() => setShowPolicy(!showPolicy)}>
                      <SlidersHorizontal size={14} /> {showPolicy ? 'Hide' : 'Edit'} experiment
                      prompt
                    </button>
                  </div>
                  <div>
                    <label className="sample-field">
                      Sample
                      <input
                        aria-label="Evaluation sample size"
                        type="number"
                        min="1"
                        max="1000"
                        value={sample}
                        onChange={(e) => setSample(Number(e.target.value))}
                      />
                    </label>
                    <button
                      className="button primary"
                      disabled={running || !exampleCount || models.some((m) => !m.model.trim())}
                      onClick={() => {
                        setRunning(true);
                        void act(async () => {
                          await api('/evaluations', {
                            method: 'POST',
                            body: JSON.stringify({
                              datasetId: selected,
                              models,
                              limit: sample,
                              policy,
                            }),
                          });
                          await load();
                        }, 'Comparison queued. Results appear as each model completes.').finally(
                          () => setRunning(false),
                        );
                      }}
                    >
                      <Play size={15} /> Run comparison
                    </button>
                  </div>
                </div>
                {showPolicy && (
                  <label className="field experiment-prompt">
                    Experiment prompt
                    <textarea rows={6} value={policy} onChange={(e) => setPolicy(e.target.value)} />
                    <small>
                      This prompt is saved with the run. Your live moderation policy is edited in
                      Settings.
                    </small>
                  </label>
                )}
                <div className="cost-note">
                  <Zap size={13} /> A comparison makes real provider calls. Adjusting the threshold
                  afterward is free.
                </div>
                <div className="cost-note">
                  <Clock3 size={13} /> Model lab: {number(data.stats.labTokens)} tokens today. No
                  daily token limit; provider billing applies. Live moderation has a separate
                  budget.
                </div>
                <div className="cost-note">
                  Jev and Clef use the Decisions API automatically through OpenRouter.
                </div>
              </section>
              <section className="panel threshold-panel">
                <div>
                  <span className="threshold-icon">
                    <SlidersHorizontal size={21} />
                  </span>
                  <div>
                    <h3>Find your balance.</h3>
                    <p>
                      Higher thresholds mean fewer false positives. Scores are model signals;
                      validate them on your labels.
                    </p>
                  </div>
                </div>
                <label className="threshold-slider">
                  <span>
                    Spam threshold <strong>{threshold.toFixed(2)}</strong>
                  </span>
                  <input
                    aria-label="Comparison spam threshold"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                  <div>
                    <small>More sensitive</small>
                    <small>More selective</small>
                  </div>
                </label>
              </section>
              <section className="panel results-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Results, without the guesswork.</h2>
                    <p>Review the saved scores below. Human labels unlock precision and recall.</p>
                  </div>
                  {selectedRuns.length > 0 && (
                    <div className="run-actions">
                      <span className="tag">{selectedRuns.length} recent runs</span>
                      {displayRun?.predictions.length ? (
                        <button
                          className="button secondary"
                          onClick={() =>
                            document
                              .getElementById('run-review')
                              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }
                        >
                          Review {displayRun.total} messages <ArrowRight size={14} />
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
                {!selectedRuns.length ? (
                  <Empty icon={FlaskConical} title="Your first experiment awaits">
                    Run a comparison to see precision, recall, false positives, latency, and token
                    usage.
                  </Empty>
                ) : (
                  <>
                    <div className="table-scroll">
                      <table className="results-table">
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th>Precision</th>
                            <th>Recall</th>
                            <th>F1</th>
                            <th>False +</th>
                            <th>Tokens</th>
                            <th>Total latency</th>
                            <th>Cost</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRuns.map((r, i) => {
                            const scores = metrics(reviewedExamples(r), r.predictions, threshold);
                            return (
                              <tr
                                className={displayRun?.id === r.id ? 'selected-run' : ''}
                                key={r.id}
                                onClick={() => setRunSelected(r.id)}
                              >
                                <td>
                                  <div className="run-model">
                                    <span className={`model-number color-${i % 5}`}>
                                      <FlaskConical size={15} />
                                    </span>
                                    <div>
                                      <strong>{r.model}</strong>
                                      <small>
                                        {r.status} · {r.cursor}/{r.total} scored · {scores.count}{' '}
                                        labelled
                                      </small>
                                      {r.error && <small className="red">{r.error}</small>}
                                    </div>
                                  </div>
                                </td>
                                <td>{percent(scores.precision)}</td>
                                <td>{percent(scores.recall)}</td>
                                <td>{scores.f1 === null ? '—' : scores.f1.toFixed(3)}</td>
                                <td>
                                  <span className={scores.fp ? 'red' : ''}>
                                    {scores.count ? scores.fp : '—'}
                                  </span>
                                </td>
                                <td>
                                  {!r.input_tokens &&
                                  !r.output_tokens &&
                                  (r.usage_incomplete || r.error.includes('message ID'))
                                    ? 'unknown'
                                    : number(r.input_tokens + r.output_tokens)}
                                  {r.usage_estimated ? ' est.' : ''}
                                  {r.usage_incomplete && (r.input_tokens || r.output_tokens)
                                    ? ' + unknown'
                                    : ''}
                                </td>
                                <td>
                                  {r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)}s` : '—'}
                                </td>
                                <td>{r.cost === null ? '—' : `$${r.cost.toFixed(5)}`}</td>
                                <td>
                                  <div className="run-actions">
                                    {r.status === 'failed' && (
                                      <button
                                        className="text-button"
                                        aria-label={`Resume run ${r.model}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void act(async () => {
                                            await api(`/evaluations/${r.id}/resume`, {
                                              method: 'POST',
                                              body: '{}',
                                            });
                                            await load();
                                          }, 'Run resumed from its saved progress.');
                                        }}
                                      >
                                        Resume
                                      </button>
                                    )}
                                    {['queued', 'running'].includes(r.status) ? (
                                      <button
                                        className="text-button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void act(async () => {
                                            await api(`/evaluations/${r.id}/cancel`, {
                                              method: 'POST',
                                              body: '{}',
                                            });
                                            await load();
                                          }, 'Run cancelled. An in-flight provider call may still be billed.');
                                        }}
                                      >
                                        Cancel
                                      </button>
                                    ) : (
                                      <button
                                        className="icon-button"
                                        aria-label={`Export run ${r.model}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          download(`watchtower-run-${r.id}.json`, {
                                            ...r,
                                            effectiveExamples: reviewedExamples(r),
                                            threshold,
                                            metrics: scores,
                                          });
                                        }}
                                      >
                                        <ArrowDownToLine size={15} />
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="results-footer">
                      Select a run to review its messages below. Label the scored sample to measure
                      accuracy; adjusting labels or thresholds makes no provider calls.
                    </div>
                  </>
                )}
              </section>
              {displayRun && (
                <>
                  <RunReview
                    run={displayRun}
                    runs={selectedRuns}
                    threshold={threshold}
                    savingLabels={savingLabels}
                    onLabel={async (runId, id, label) => {
                      const run = runs.find((r) => r.id === runId);
                      const example = run && reviewedExamples(run).find((e) => e.id === id);
                      if (run && example) await saveLabel(run.dataset_id, example, label, runId);
                    }}
                  />
                  <div className="lab-detail-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Threshold trade-off</h2>
                          <p>{displayRun.model}</p>
                        </div>
                        <span className="tag">Saved scores</span>
                      </div>
                      <ThresholdChart run={displayRun} threshold={threshold} />
                      <div className="chart-footer">
                        <span>
                          <i className="legend-dot all" /> Precision
                        </span>
                        <span>
                          <i className="legend-dot spam" /> Recall
                        </span>
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>False positives</h2>
                          <p>Legitimate messages flagged at {threshold.toFixed(2)}.</p>
                        </div>
                        <span className="tag">{falsePositives.length}</span>
                      </div>
                      {falsePositives.length ? (
                        <div className="mistakes-list">
                          {falsePositives.slice(0, 8).map((e) => (
                            <div key={e.id}>
                              <span>#{e.id}</span>
                              <p>{e.text}</p>
                              <strong>
                                {percent(displayRun.predictions.find((p) => p.id === e.id)!.score)}
                              </strong>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          icon={CheckCircle2}
                          title={
                            reviewedExamples(displayRun).some((e) => e.label === 'ham')
                              ? 'No false positives at this threshold'
                              : 'Label legitimate messages first'
                          }
                        >
                          Check recall too: a high threshold can let spam through.
                        </Empty>
                      )}
                    </section>
                  </div>
                  <details className="run-prompt">
                    <summary>View this run’s saved prompt</summary>
                    <pre>{displayRun.policy}</pre>
                  </details>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
function ThresholdChart({ run, threshold }: { run: Evaluation; threshold: number }) {
  const values = Array.from({ length: 21 }, (_, i) => ({
    x: i / 20,
    ...metrics(reviewedExamples(run), run.predictions, i / 20),
  }));
  const path = (key: 'precision' | 'recall') =>
    values
      .filter((v) => v[key] !== null)
      .map((v, i) => `${i ? 'L' : 'M'}${40 + v.x * 410},${175 - v[key]! * 140}`)
      .join(' ');
  return (
    <div className="threshold-chart">
      <svg viewBox="0 0 480 220" role="img" aria-label="Precision and recall versus spam threshold">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1="40"
              y1={175 - v * 140}
              x2="450"
              y2={175 - v * 140}
              stroke="#e9ece5"
              strokeDasharray="3 4"
            />
            <text x="30" y={179 - v * 140} textAnchor="end">
              {v * 100}%
            </text>
            <text x={40 + v * 410} y="200" textAnchor="middle">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        <path d={path('precision')} stroke="#6c8760" strokeWidth="2.5" fill="none" />
        <path d={path('recall')} stroke="#d78961" strokeWidth="2.5" fill="none" />
        <line
          x1={40 + threshold * 410}
          x2={40 + threshold * 410}
          y1="28"
          y2="180"
          stroke="#333e31"
          strokeDasharray="4 4"
        />
        <text
          x={Math.min(420, 40 + threshold * 410)}
          y="19"
          textAnchor="middle"
          className="threshold-chart-current"
        >
          {threshold.toFixed(2)}
        </text>
      </svg>
    </div>
  );
}

function SettingsPage({ data, act, busy }: { data: Overview; act: Act; busy: boolean }) {
  const api = useMemo(() => apiForGroup(data.chatId), [data.chatId]);
  const [settings, setSettings] = useState<Settings>(data.settings),
    [saved, setSaved] = useState(JSON.stringify(data.settings));
  const [telegramStatus, setTelegramStatus] = useState<unknown>(null);
  const dirty = JSON.stringify(settings) !== saved;
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
  }
  return (
    <>
      <PageHeading
        eyebrow="YOUR COMMUNITY, YOUR RULES"
        title="Set the boundaries."
        subtitle="Evolve the policy, choose your model, and control when moderation takes action."
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const result = await api<Settings>('/settings', {
              method: 'PUT',
              body: JSON.stringify(settings),
            });
            setSettings(result);
            setSaved(JSON.stringify(result));
          }, 'Moderation settings saved.');
        }}
      >
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Moderation mode</h2>
              <p>Start by observing. Switch to enforcement when your policy is ready.</p>
            </div>
            <ShieldCheck size={20} className="muted" />
          </div>
          <div className="mode-options">
            {[
              {
                value: 'observe',
                icon: Search,
                title: 'Observe',
                description: 'Classify and log. No deletions or strikes.',
              },
              {
                value: 'enforce',
                icon: ShieldCheck,
                title: 'Enforce',
                description: 'Delete spam. Purge at two. Ban at three.',
              },
              {
                value: 'paused',
                icon: Pause,
                title: 'Pause',
                description: 'Capture messages. Hold classification and actions.',
              },
            ].map((m) => (
              <button
                type="button"
                key={m.value}
                className={settings.mode === m.value ? 'selected' : ''}
                onClick={() => update('mode', m.value as Settings['mode'])}
              >
                <m.icon size={21} />
                <strong>{m.title}</strong>
                <p>{m.description}</p>
                <span className="radio">{settings.mode === m.value && <i />}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>The spam policy</h2>
              <p>A living prompt. Adapt it as your community and spam patterns change.</p>
            </div>
            <span className="tag">Editable</span>
          </div>
          <label className="field">
            Classification instructions
            <textarea
              aria-label="Spam policy"
              rows={7}
              minLength={20}
              maxLength={6000}
              required
              value={settings.policy}
              onChange={(e) => update('policy', e.target.value)}
            />
            <small>
              Message text is treated as untrusted input. Each evaluation stores its own prompt
              snapshot.
            </small>
          </label>
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Model & decision thresholds</h2>
              <p>Use Model lab to test changes before applying them here.</p>
            </div>
            <FlaskConical size={20} className="muted" />
          </div>
          <div className="fields-grid">
            <label className="field">
              Provider
              <select
                value={settings.provider}
                onChange={(e) => {
                  update('provider', e.target.value);
                  update(
                    'model',
                    e.target.value === 'jev' ? 'typesafe/jev-1.13' : 'google/gemini-2.5-flash-lite',
                  );
                }}
              >
                {data.providers.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                    {p.configured ? '' : ' · key needed'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model ID
              <input
                required
                value={settings.model}
                onChange={(e) => update('model', e.target.value)}
              />
              <small>Any model supported by the selected endpoint.</small>
            </label>
            <label className="field">
              Spam threshold
              <input
                type="number"
                min="0.5"
                max="1"
                step="0.01"
                value={settings.threshold}
                onChange={(e) => update('threshold', Number(e.target.value))}
              />
              <small>Scores at or above this threshold are spam.</small>
            </label>
            <label className="field">
              Review threshold
              <input
                type="number"
                min="0"
                max={settings.threshold}
                step="0.01"
                value={settings.reviewThreshold}
                onChange={(e) => update('reviewThreshold', Number(e.target.value))}
              />
              <small>Uncertain messages stay visible and enter review.</small>
            </label>
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Batching & storage</h2>
              <p>Balance response time, prompt overhead, and retained history.</p>
            </div>
            <Zap size={20} className="muted" />
          </div>
          <div className="fields-grid">
            <label className="field">
              Batch window (seconds)
              <input
                type="number"
                min="1"
                max="60"
                value={settings.batchSeconds}
                onChange={(e) => update('batchSeconds', Number(e.target.value))}
              />
              <small>
                Minimum collection time. Production processes messages on the next minute tick.
              </small>
            </label>
            <label className="field">
              Messages per model call
              <input
                type="number"
                min="1"
                max="30"
                value={settings.batchSize}
                onChange={(e) => update('batchSize', Number(e.target.value))}
              />
              <small>Messages share one policy prompt.</small>
            </label>
            <label className="field">
              Daily moderation token budget
              <input
                type="number"
                min="1000"
                max="10000000"
                value={settings.dailyTokenBudget}
                onChange={(e) => update('dailyTokenBudget', Number(e.target.value))}
              />
              <small>Live moderation only. Resets at midnight UTC.</small>
            </label>
            <label className="field">
              Message retention (days)
              <input
                type="number"
                min="3"
                max="365"
                value={settings.retentionDays}
                onChange={(e) => update('retentionDays', Number(e.target.value))}
              />
              <small>Strikes and datasets persist until explicitly reset or deleted.</small>
            </label>
          </div>
          <div className="budget-bar">
            <span>
              Today’s moderation usage{' '}
              <strong>
                {number(data.stats.tokens)} / {number(settings.dailyTokenBudget)} tokens
              </strong>
            </span>
            <div>
              <i
                style={{
                  width: `${Math.min(100, (data.stats.tokens / settings.dailyTokenBudget) * 100)}%`,
                }}
              />
            </div>
            <small>
              Model lab has no daily token limit and is tracked separately. Conservative
              reservations count when usage is unavailable. Configure provider spend limits for a
              hard billing cap.
            </small>
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <h2>Protected users</h2>
              <p>The owner and Telegram administrators are always exempt.</p>
            </div>
            <LockKeyhole size={20} className="muted" />
          </div>
          <label className="field">
            Additional exempt Telegram user IDs
            <input
              value={settings.exemptUserIds.join(', ')}
              onChange={(e) =>
                update(
                  'exemptUserIds',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              placeholder="12345678, 98765432"
            />
            <small>Comma-separated numeric user IDs. Usernames are not stable identifiers.</small>
          </label>
        </section>
        <div className="settings-save">
          <span>{dirty ? 'You have unsaved changes.' : 'Your settings are up to date.'}</span>
          <button type="submit" className="button primary" disabled={busy || !dirty}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} Save settings
          </button>
        </div>
      </form>
      <section className="panel settings-panel connection-panel">
        <div className="panel-heading">
          <div>
            <h2>Connections</h2>
            <p>Credentials stay on the worker. The browser never receives API keys.</p>
          </div>
          <button
            className="text-button"
            onClick={() => void act(async () => setTelegramStatus(await api('/telegram/status')))}
          >
            <RefreshCw size={14} /> Check Telegram
          </button>
        </div>
        <div className="connections-list">
          {data.providers.map((p) => (
            <div key={p.id}>
              <span>
                <FlaskConical size={17} />
                {p.name}
              </span>
              <code>{p.baseUrl}</code>
              <span className={`connection ${p.configured ? 'ready' : ''}`}>
                <i />
                {p.configured ? 'Key configured' : 'Key needed'}
              </span>
            </div>
          ))}
        </div>
        {telegramStatus !== null && (
          <pre className="connection-status">{JSON.stringify(telegramStatus, null, 2)}</pre>
        )}
        <p className="field-help">
          Add custom OpenAI-compatible endpoints through MODEL_PROVIDERS_JSON. See README.md for
          secrets and Cloudflare Access configuration.
        </p>
      </section>
    </>
  );
}
