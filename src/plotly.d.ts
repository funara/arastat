declare module 'plotly.js-dist-min' {
  interface PlotlyLike {
    react(target: HTMLElement, data: unknown[], layout?: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>
  }
  const Plotly: PlotlyLike
  export default Plotly
}
