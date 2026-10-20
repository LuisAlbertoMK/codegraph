<script lang="ts">
  // Flow draws on @xyflow/svelte; see MapViewLazy.svelte.
  interface Props {
    from: string | null;
    to: string | null;
    symbols: string | null;
    trailParam: string | null;
  }

  let props: Props = $props();
  const view = import('./FlowView.svelte');
</script>

{#await view then loaded}
  {@const View = loaded.default}
  <View {...props} />
{/await}
