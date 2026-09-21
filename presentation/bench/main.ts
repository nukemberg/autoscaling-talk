import { createApp } from 'vue'
import Bench from './Bench.vue'
import Chart from '../components/Chart.vue'
import ParamPanel from '../components/ParamPanel.vue'
import SimCharts from '../components/SimCharts.vue'

// Slidev auto-registers components/; the bench registers the ones it shares.
createApp(Bench)
  .component('Chart', Chart)
  .component('ParamPanel', ParamPanel)
  .component('SimCharts', SimCharts)
  .mount('#app')
