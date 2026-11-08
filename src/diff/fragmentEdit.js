import { getMessageDiffMeta, isMessageDiffReverted, writeMessageDiffAiStage } from './messageMeta.js';
import { getMessageDiffBranchKey, commitCurrentMessageText, clearMessageDisplayText, syncCurrentSwipeExtra } from '../chat/messageBranch.js';

export function captureFragmentEdit(chat, msg, section, change) {
    const meta = getMessageDiffMeta(msg);
    if (!Array.isArray(chat) || !chat.includes(msg) || !meta || isMessageDiffReverted(msg) || msg.mes !== meta.programMes) return null;
    const oldText = section === 'ai' ? meta.originalMes : meta.aiMes ?? meta.originalMes;
    const newText = section === 'ai' ? meta.aiMes : meta.programMes;
    // Intermediate-stage offsets are not final-body offsets. Do not guess a mapping.
    if (!['ai', 'program'].includes(section) || newText !== msg.mes) return null;
    const { oldStart, oldEnd, newStart, newEnd, deletedText, insertedText } = change;
    if (![oldStart, oldEnd, newStart, newEnd].every(Number.isInteger)
        || oldStart < 0 || oldEnd < oldStart || oldEnd > oldText.length
        || newStart < 0 || newEnd < newStart || newEnd > newText.length
        || oldText.slice(oldStart, oldEnd) !== deletedText || newText.slice(newStart, newEnd) !== insertedText) return null;
    return { chat, msg, index: chat.indexOf(msg), branch: getMessageDiffBranchKey(msg), meta, section, newStart, newEnd, deletedText, insertedText, text: msg.mes };
}

// Validate all edits against the same message, Swipe and Difference snapshot.
// Compose from the right so previously recorded offsets do not shift.
function applyFragmentReplacements(chat, draft, replacements) {
    if (!draft || chat !== draft.chat || chat[draft.index] !== draft.msg
        || !Array.isArray(replacements) || replacements.length === 0) return false;
    const { msg, meta, branch } = draft;
    if (getMessageDiffBranchKey(msg) !== branch || msg.mes !== draft.text || isMessageDiffReverted(msg)
        || JSON.stringify(getMessageDiffMeta(msg)) !== JSON.stringify(meta)) return false;

    const ordered = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end);
    let next = draft.text;
    let rightBoundary = draft.text.length + 1;
    for (const { start, end, before, after } of ordered) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
            || end > draft.text.length || end > rightBoundary || start === rightBoundary
            || typeof before !== 'string' || typeof after !== 'string'
            || draft.text.slice(start, end) !== before) return false;
        next = next.slice(0, start) + after + next.slice(end);
        rightBoundary = start;
    }

    if (!commitCurrentMessageText(msg, next, branch).ok) return false;
    // Retain the original/AI stages; the selectively restored text becomes the final stage.
    writeMessageDiffAiStage(msg, branch, meta.originalMes, meta.aiMes, next, meta.aiUnchanged);
    clearMessageDisplayText(msg);
    syncCurrentSwipeExtra(msg);
    return true;
}

export function applyFragmentEdit(chat, draft, value) {
    if (!draft || typeof value !== 'string') return false;
    return applyFragmentReplacements(chat, draft, [{
        start: draft.newStart, end: draft.newEnd,
        before: draft.insertedText, after: value,
    }]);
}

// A snippet may contain more than one edit. Restore them as one atomic commit
// instead of letting the first edit invalidate subsequent offsets.
export function captureSnippetRestore(chat, msg, section, changes) {
    if (!Array.isArray(changes) || changes.length === 0) return null;
    const drafts = changes.map(change => captureFragmentEdit(chat, msg, section, change));
    if (drafts.some(draft => !draft)) return null;
    return {
        ...drafts[0],
        replacements: drafts.map(draft => ({
            start: draft.newStart, end: draft.newEnd,
            before: draft.insertedText, after: draft.deletedText,
        })),
    };
}

export function applySnippetRestore(chat, draft) {
    return applyFragmentReplacements(chat, draft, draft?.replacements);
}
