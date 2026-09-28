<script lang="ts">
  const ITEMS = [
    { style: "auto", label: "Auto-post" },
    { style: "assisted", label: "Assisted (reminder + open)" },
    { style: "overdue", label: "Overdue" },
    { style: "attention", label: "Needs attention" },
    { style: "draft", label: "Draft / idea" },
    { style: "published", label: "Published" },
  ];
</script>

<ul class="osmm-legend" aria-label="Legend">
  {#each ITEMS as item (item.style)}
    <li class="osmm-row"><span class="osmm-chip" data-style={item.style} aria-hidden="true">&nbsp;</span>{item.label}</li>
  {/each}
</ul>
