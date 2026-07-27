import { startPursuitGame } from "./game";
import "./globals.css";
import { createYouTubePlayablesLifecycle } from "./youtube-playables";

const youtubePlayables = createYouTubePlayablesLifecycle();
youtubePlayables.firstFrameReady();
const loadingStatus = document.getElementById("status-value");
if (loadingStatus) loadingStatus.textContent = "SYNCING CLOUD SAVE…";
const cloudSaveData = await youtubePlayables.loadCloudData();
if (loadingStatus) loadingStatus.textContent = "LOADING VEHICLES…";
startPursuitGame(youtubePlayables, cloudSaveData);
