/*
 * Theme CSS is discovered from the packaged theme directory. Metadata and
 * selectable IDs live in themes/themes.json; this glob keeps adding a theme
 * file from requiring another CSS import list.
 */
import.meta.glob("./themes/*.css", { eager: true });
