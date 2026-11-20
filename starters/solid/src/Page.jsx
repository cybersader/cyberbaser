import { For, Show } from 'solid-js';
import { HOME, CATALOG, CSS, relativeUrl } from './routes.js';

// Change this name, the layout below, and reader.css to make this reader yours.
const siteName = 'Notebook';
const policy = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

function Frame(props) {
  const link = (to) => relativeUrl(props.file, to);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content={policy} />
        <meta name="referrer" content="no-referrer" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} | {siteName}</title>
        <link rel="stylesheet" href={link(CSS)} />
      </head>
      <body>
        <a class="skip" href="#reader-main">Skip to content</a>
        <header class="masthead">
          <nav aria-label="Site">
            <a class="brand" href={link(HOME)}>{siteName}</a>
            <a href={link(CATALOG)} aria-current={props.file === CATALOG ? 'page' : undefined}>All notes</a>
          </nav>
        </header>
        <main id="reader-main" class="layout">{props.children}</main>
        <footer class="footer">Read-only knowledge base</footer>
      </body>
    </html>
  );
}

export function NotePage(props) {
  const note = props.note;
  return (
    <Frame file={note.file} title={note.title}>
      <header class="page-heading">
        <p class="eyebrow">{note.file === HOME ? 'Home' : 'Published note'}</p>
        <h1>{note.title}</h1>
      </header>
      <Show when={note.headings.length > 1}>
        <nav class="contents" aria-label="On this page">
          <h2>On this page</h2>
          <ul><For each={note.headings}>{(item) => (
            <li class={`level-${item.level}`}><a href={`#${encodeURIComponent(item.id)}`}>{item.label}</a></li>
          )}</For></ul>
        </nav>
      </Show>
      {/* The only HTML insertion is the output of our locked-down Markdown renderer. */}
      <article class="prose" innerHTML={props.markdownHtml} />
    </Frame>
  );
}

export function CatalogPage(props) {
  return (
    <Frame file={props.file} title="All notes">
      <header class="page-heading">
        <p class="eyebrow">Knowledge base</p>
        <h1>All notes</h1>
        <p>{props.count} {props.count === 1 ? 'published note' : 'published notes'}</p>
      </header>
      <div class="catalog">
        <For each={props.groups}>{([folder, notes]) => (
          <section>
            <h2>{folder || 'Top level'}</h2>
            <ul><For each={notes}>{(note) => (
              <li><a href={relativeUrl(props.file, note.file)}>{note.title}</a></li>
            )}</For></ul>
          </section>
        )}</For>
      </div>
    </Frame>
  );
}
