/**
 * Terminal sanitizers shared by command reporting and the views. Every string
 * that reaches the terminal from outside this extension — captured content,
 * configuration files, error messages — passes through here first.
 */

const TERMINAL_STRING_START = /\u001B[\]PX^_]|[\u0090\u0098\u009D\u009E\u009F]/g;
const TERMINAL_STRING_END = /\u0007|\u001B\\|\u009C/g;
const TERMINAL_CSI_SEQUENCE = /(?:\u001B\[|\u009B)[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]/g;
const TERMINAL_ESCAPE_SEQUENCE = /\u001B[\u0020-\u002F]*[\u0030-\u007E]/g;
const TERMINAL_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Normalize whitespace and remove terminal control sequences from raw preview text. */
export function normalizePreviewText(text: string): string {
	const normalized = text
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll("\t", "    ");
	return stripTerminalStrings(normalized)
		.replace(TERMINAL_CSI_SEQUENCE, "")
		.replace(TERMINAL_ESCAPE_SEQUENCE, "")
		.replace(TERMINAL_CONTROL_CHARACTER, "");
}

/** Remove complete terminal strings without rescanning an unterminated suffix for every start. */
function stripTerminalStrings(text: string): string {
	const parts: string[] = [];
	let offset = 0;
	TERMINAL_STRING_START.lastIndex = 0;
	let start: RegExpExecArray | null;
	while ((start = TERMINAL_STRING_START.exec(text)) !== null) {
		TERMINAL_STRING_END.lastIndex = TERMINAL_STRING_START.lastIndex;
		if (TERMINAL_STRING_END.exec(text) === null) break;
		parts.push(text.slice(offset, start.index));
		offset = TERMINAL_STRING_END.lastIndex;
		TERMINAL_STRING_START.lastIndex = offset;
	}
	// Preserve an incomplete string for the existing escape/control sanitizers.
	parts.push(text.slice(offset));
	return parts.join("");
}

/** Sanitize dynamic text for one terminal line and collapse embedded whitespace. */
export function normalizeInlineText(text: string): string {
	return normalizePreviewText(text).replace(/\s+/g, " ").trim();
}
