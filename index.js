const server = async (api, options) => {
  // Return an empty hooks object to satisfy the backend loader constraint
  return {};
};

const plugin = {
  id: "cache-timer",
  server,
};

export default plugin;
export { server };
