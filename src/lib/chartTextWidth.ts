/** Conservative label width used to reserve chart margins before text is laid out. */
export function chartTextWidth(text: string): number {
  return Array.from(text).reduce((width, character) => width + (character.charCodeAt(0) < 128 ? 7 : 12), 0)
}
