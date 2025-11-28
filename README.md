# Cuneiform Scorer

A web-based tool for creating synoptic scores from multiple manuscript witnesses. Designed for textual criticism and manuscript collation work.

## Features

- **Simple text-based input**: Write manuscript content naturally with line markers
- **Live synoptic score**: See all witnesses aligned by line in real-time
- **Editable reconstructed text**: Add your own reconstructed reading for each line
- **Auto-save**: Changes save automatically to text files
- **Export**: Download the score as a plain text file

## Format

Manuscripts use a simple plain-text format:

```
Ms. A
obverse
§1 1. lu₂ gal-e ki-ta ba-an-zig₃
§2 2. nam-lu₂-ulu₃ saĝ gig₂-ga

reverse
§5 1. an-ki niĝin₂-na
```

Where:
- `§1` = target line in the synoptic score
- `1.` = manuscript's own line number
- Text after = the content

Surface markers (`obverse`, `reverse`, `edge`, `left edge`, `right edge`, `top`, `bottom`) are detected automatically.

## Output

The generated score looks like:

```
SYNOPTIC SCORE
==============

§ 1 [reconstructed text here]
  A obverse 1     lu₂ gal-e ki-ta ba-an-zig₃
  B obverse 1     lu₂ gal ki-ta ba-zig₃

§ 2 [reconstructed text here]
  A obverse 2     nam-lu₂-ulu₃ saĝ gig₂-ga
  B obverse 2     nam-lu₂-ulu₃ saĝ gig₂
```

## Installation

### Local Development (with auto-save)

1. Clone or download this repository
2. Run the server:
   ```bash
   npm start
   ```
3. Open `http://localhost:3000` in your browser

### Static Hosting (GitHub Pages)

The app works on GitHub Pages without the server, but auto-save to files is disabled. Data persists in the browser only.

1. Push to a GitHub repository
2. Enable GitHub Pages in repository settings
3. Access at `https://yourusername.github.io/cuneiform-scorer/`

## File Structure

```
cuneiform-scorer/
├── index.html          # Main HTML
├── styles.css          # Styles
├── app.js              # Application logic
├── server.js           # Local dev server (Node.js)
├── package.json        # npm scripts
├── score.txt           # Generated score (auto-saved)
└── manuscripts/
    ├── index.json      # List of manuscript sigla
    ├── A.txt           # Manuscript A content
    └── B.txt           # Manuscript B content
```

## Adding Manuscripts

1. Create a new file in `manuscripts/` (e.g., `C.txt`)
2. Add the siglum to `manuscripts/index.json`: `["A", "B", "C"]`
3. Refresh the page

Or use the "+ Add Manuscript" button in the app.

## License

MIT
