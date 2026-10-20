<script lang="ts">
  // Steps draws on @xyflow/svelte; see MapViewLazy.svelte.
  interface Props {
    anchor: string | null;
    symbol: string | null;
    depth: number | null;
    through: boolean;
    reading: 'order' | 'tree' | null;
  }

  let props: Props = $props();
  const view = import('./StepsView.svelte');
</script>

{#await view then loaded}
  {@const View = loaded.default}
  <View {...props} />
{/await}
