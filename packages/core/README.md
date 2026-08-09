# `@openlimiter/core`

Shared types, quota models, cache handling, and forecasts for OpenLimiter.

The advice policy recommends only a bounded provider enum. It selects the fresh healthy provider with the lowest usage, uses configured provider order for ties, and returns `NONE` when no provider is usable.

Most users should install the [`openlimiter`](https://www.npmjs.com/package/openlimiter) CLI.

See the [repository](https://github.com/lucaswebsystems/openlimiter) and [OpenLimiter site](https://openlimiter.com).
