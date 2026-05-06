import { createApp } from "vue";
import { bootstrapAuth } from "@csbc-dev/auth0";
import { defineAppCoreFacade } from "../../shared/appCoreFacade.js";
import App from "./App.vue";

bootstrapAuth();
defineAppCoreFacade();

createApp(App).mount("#app");
