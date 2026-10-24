// Keep Angular modules and socket mocks isolated between specs on small build machines.
export default {
  test: {
    isolate: true,
    maxWorkers: 1,
    fileParallelism: false
  }
};
