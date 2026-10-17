// Validate the resolved Compose model, where YAML comma splitting is observable.
export function validateTmpfsMounts(services) {
 for (const service of Object.values(services ?? {})) {
  for (const mount of service.tmpfs ?? []) {
   const [path, options, extra] = typeof mount === 'string' ? mount.split(':') : [];
   const flags = options?.split(',') ?? [];
   const size = flags.find(flag=>/^size=\d+m$/.test(flag));
   if (!path?.startsWith('/') || path.split('/').includes('..') || extra !== undefined
    || !['rw','noexec','nosuid'].every(flag=>flags.includes(flag))
    || !size || Number(size.slice(5,-1))<1 || Number(size.slice(5,-1))>64) {
    throw new Error('Invalid production tmpfs mount in resolved Compose model');
   }
  }
 }
}