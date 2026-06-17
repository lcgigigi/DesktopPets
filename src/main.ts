import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/base.css'
import './assets/styles/app.css'

createApp(App).use(createPinia()).mount('#app')

