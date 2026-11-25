export function createIntakeScope() {
  let enabled = true
  let sequence = 0
  return {
    activate() { enabled = true; sequence++ },
    dispose() { enabled = false; sequence++ },
    active() { return enabled },
    beginRefresh() { return ++sequence },
    current(token:number) { return enabled && token === sequence },
  }
}
