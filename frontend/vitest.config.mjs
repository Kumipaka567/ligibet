// Keep Angular modules and socket mocks isolated between specs on small build machines.
export default {
  test: {
    isolate: true,
    maxWorkers: 1,
    fileParallelism: false,
    // Component compilation can exceed the default limits on this machine.
    testTimeout: 15000,
    hookTimeout: 30000
  }
};
