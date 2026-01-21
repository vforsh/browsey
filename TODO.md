# TODO

## Bug: Nav buttons showing for markdown preview

### Issue
When viewing markdown files, both font size buttons (`A-`/`A+`) AND navigation arrows (`<`/`>`) are displayed. Only font size buttons should be visible for text/markdown content.

### Expected Behavior
- **Markdown/code files**: Show only `A-` and `A+` buttons
- **Images (with siblings)**: Show only `<` and `>` buttons
- **Images (single)**: Show no navigation buttons

### Current Code Logic
The `updateControlButtons()` function in `src/ui/app.ts` should handle this:

```typescript
private updateControlButtons(): void {
  const isImage = this.currentContentType === 'image'
  const isText = this.currentContentType === 'text'

  // Image navigation: show only for images with nav context
  const hasImageNav = this.imageNav !== null
  this.prevBtn.hidden = !(isImage && hasImageNav)  // Should be true for text
  this.nextBtn.hidden = !(isImage && hasImageNav)  // Should be true for text

  // Font controls: show only for text content
  this.fontDecreaseBtn.hidden = !isText  // Should be false for text
  this.fontIncreaseBtn.hidden = !isText  // Should be false for text
  ...
}
```

### Debugging Steps
1. Verify browser cache is cleared (hard refresh: Cmd+Shift+R)
2. Check if running built version (`./dist/browsey`) vs dev (`bun run dev`)
3. Inspect element in browser to see button `hidden` attribute state
4. Add console.log in `updateControlButtons()` to trace values:
   ```typescript
   console.log('updateControlButtons:', { isImage, isText, hasImageNav, contentType: this.currentContentType })
   ```

### Files Involved
- `src/ui/app.ts` - FileViewer class, `updateControlButtons()` method
- `src/ui/index.html` - Button elements with `hidden` attribute
