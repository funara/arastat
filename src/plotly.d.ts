declare module 'plotly.js-dist-min' {
  interface PlotlyLike {
    react(target: HTMLElement, data: unknown[], layout?: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>
    /** Serializes the rendered plot; format 'svg'/'png' resolves to a data: URL. */
    toImage(target: HTMLElement, opts?: Record<string, unknown>): Promise<string>
  }
  const Plotly: PlotlyLike
  export default Plotly
}
