<script lang="ts">
  // The Map is one of four screens built on @xyflow/svelte. Loading it on
  // demand keeps that dependency out of the viewer's first chunk, which every
  // symbol/file/dead-code screen pays for otherwise.
  interface Props {
    root: string | null;
    depth: number | null;
    tests: boolean;
  }

  let props: Props = $props();
  const view = import('./MapView.svelte');
</script>

{#await view then loaded}
  {@const View = loaded.default}
  <View {...props} />
{/await}
