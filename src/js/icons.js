// Inline SVG icons for the file tree and panels.

export const ICON_CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const ICON_FOLDER_CLOSED = `<svg class="folder-svg-closed" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="none" stroke="var(--icon-folder)" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1"/></svg>`;
export const ICON_FOLDER_OPEN = `<svg class="folder-svg-open" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="none" stroke="var(--icon-folder)" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-1.75 7a1 1 0 0 1-.97.76H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1"/></svg>`;
export const ICON_FILE_MD = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="none" stroke="var(--icon-md)" stroke-linecap="round" stroke-linejoin="round" d="m9.25 8.25l2.25 2.25l2.25-2.25M3.5 11V5.5l2.04 3l1.96-3V11m4-.5V5M1.65 2.5h12.7c.59 0 1.15.49 1.15 1v9c0 .51-.56 1-1.15 1H1.65c-.59 0-1.15-.49-1.15-1V3.58c0-.5.56-1.08 1.15-1.08"/></svg>`;
export const ICON_FILE_GENERIC = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15"><path fill="none" stroke="var(--icon-file)" stroke-linecap="round" stroke-linejoin="round" d="M3 2.5C3 2.22 3.22 2 3.5 2H9.09c.13 0 .26.05.35.15l2.41 2.41c.1.09.15.22.15.35V12.5c0 .28-.22.5-.5.5h-8c-.28 0-.5-.22-.5-.5v-10ZM3.5 3H8.5V5.5c0 .28.22.5.5.5H11.5V12h-8V3Z"/></svg>`;

export function getFileIcon(name) {
  return name.split(".").pop().toLowerCase() === "md" ? ICON_FILE_MD : ICON_FILE_GENERIC;
}
