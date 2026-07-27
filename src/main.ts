import { startPursuitGame } from "./game";
import "./globals.css";
import { createYouTubePlayablesLifecycle } from "./youtube-playables";

const youtubePlayables = createYouTubePlayablesLifecycle();
startPursuitGame(youtubePlayables);
