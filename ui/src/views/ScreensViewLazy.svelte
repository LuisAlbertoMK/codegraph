<script lang="ts">
  // Screens draws on @xyflow/svelte; see MapViewLazy.svelte.
  const view = import('./ScreensView.svelte');
</script>

{#await view then loaded}
  {@const View = loaded.default}
  <View />
{/await}
