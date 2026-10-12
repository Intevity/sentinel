import React from 'react';
import { ChevronRight, KeyRound, Terminal, X } from 'lucide-react';

export type AddAccountKind = 'subscription' | 'api-key';

interface AddAccountChooserProps {
  onChoose: (kind: AddAccountKind) => void;
  onClose: () => void;
}

const OPTIONS: ReadonlyArray<{
  kind: AddAccountKind;
  icon: typeof Terminal;
  title: string;
  body: string;
}> = [
  {
    kind: 'subscription',
    icon: Terminal,
    title: 'Claude subscription',
    body: 'Pro, Max, Team or Enterprise. You sign in through Claude Code in a terminal here.',
  },
  {
    kind: 'api-key',
    icon: KeyRound,
    title: 'API key',
    body: 'A personal or workspace key from the Claude Console, billed to API credits.',
  },
];

/**
 * First step of Add Account: what kind of account is being added. A Claude
 * subscription is captured from `claude setup-token` in the in-app terminal;
 * an API key is pasted into a form.
 */
export default function AddAccountChooser({
  onChoose,
  onClose,
}: AddAccountChooserProps): React.ReactElement {
  return (
    <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
        <h2 className="text-[13px] font-semibold text-black dark:text-white">Add an account</h2>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-full hover:bg-muted/10 flex items-center justify-center"
          title="Close"
          aria-label="Close"
        >
          <X size={14} className="text-muted" />
        </button>
      </div>
      <div className="p-2 space-y-1">
        {OPTIONS.map(({ kind, icon: Icon, title, body }) => (
          <button
            key={kind}
            onClick={() => onChoose(kind)}
            data-testid={`add-account-${kind}`}
            className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-xl text-left
                       hover:bg-black/[0.04] dark:hover:bg-white/[0.06] active:scale-[0.99] transition-all"
          >
            <span className="w-8 h-8 rounded-lg bg-ios-blue/10 flex items-center justify-center flex-shrink-0">
              <Icon size={15} className="text-ios-blue" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12px] font-semibold text-black dark:text-white">
                {title}
              </span>
              <span className="block text-[11px] leading-snug text-muted">{body}</span>
            </span>
            <ChevronRight size={14} className="text-muted flex-shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}
