require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Set up API keys from .env
const {
  YOUTUBE_API_KEY,
  GOOGLE_CUSTOM_SEARCH_API_KEY,
  GOOGLE_CUSTOM_SEARCH_CX,
} = process.env;

// Helper functions
const calculateYoutubeScore = (video) => {
  const views = video.views || 0;
  const likes = video.likes || 0;
  const engagementRate = views > 0 ? likes / views : 0; // Prevent division by zero

  return views * 0.5 + likes * 0.3 + engagementRate * 100 * 0.2;
};

const calculateArticleScore = (article) => {
  const relevanceScore = article.snippet.length;
  const domainScore = article.source.includes("reputable-site.com") ? 1 : 0;
  return relevanceScore + domainScore * 10;
};

const calculatePaperScore = (paper) => {
  const citations = paper.citations || 0;
  const recency = paper.date
    ? new Date().getFullYear() - new Date(paper.date).getFullYear()
    : 0;
  return citations - recency;
};

// Fetch YouTube videos
const getYoutubeVideos = async (query, pageToken = "") => {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&q=${encodeURIComponent(
    query
  )}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;

  try {
    const response = await axios.get(url);
    const videoIds = response.data.items
      .map((item) => item.id.videoId)
      .filter(Boolean) // Filters out undefined or null values
      .join(",");

    if (!videoIds) return []; // No video IDs found

    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const statsResponse = await axios.get(statsUrl);

    return response.data.items
      .map((item, index) => {
        const stats = statsResponse.data.items[index]?.statistics || {};
        const video = {
          title: item.snippet.title,
          url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
          thumbnail: item.snippet.thumbnails?.medium?.url || "",
          views: parseInt(stats.viewCount, 10) || 0,
          likes: parseInt(stats.likeCount, 10) || 0,
          nextPageToken: response.data.nextPageToken, // For pagination
          score: 0, // Initialize score to be calculated later
        };

        video.score = calculateYoutubeScore(video); // Calculate the score
        return video;
      })
      .sort((a, b) => b.score - a.score); // Sort by score
  } catch (error) {
    console.error("Error fetching YouTube data:", error.message);
    throw new Error("Could not fetch YouTube data");
  }
};

// YouTube search route
app.get("/search", async (req, res) => {
  const searchTerm = req.query.q;
  const pageToken = req.query.pageToken;

  if (!searchTerm) {
    return res.status(400).send("Please provide a search term");
  }

  try {
    const youtubeVideos = await getYoutubeVideos(searchTerm, pageToken);
    res.json({ youtube: youtubeVideos });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch articles
const fetchGoogleArticles = async (query, startIndex = 1) => {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query
  )}&key=${GOOGLE_CUSTOM_SEARCH_API_KEY}&cx=${GOOGLE_CUSTOM_SEARCH_CX}&start=${startIndex}`;

  try {
    const response = await axios.get(url);
    const articles = response.data.items.map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: item.displayLink,
      score: calculateArticleScore({
        snippet: item.snippet,
        source: item.displayLink,
      }),
    }));

    return {
      articles: articles.sort((a, b) => b.score - a.score),
      nextStartIndex: startIndex + 10,
    };
  } catch (error) {
    console.error("Error fetching articles:", error.message);
    throw new Error("Could not fetch articles from Google Custom Search");
  }
};

// Articles search route
app.get("/articles", async (req, res) => {
  const searchTerm = req.query.q;
  const startIndex = parseInt(req.query.start) || 1;

  if (!searchTerm) {
    return res.status(400).send("Please provide a search term");
  }

  try {
    const { articles, nextStartIndex } = await fetchGoogleArticles(
      searchTerm,
      startIndex
    );
    res.json({ articles, nextStartIndex });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch academic papers
const getAcademicPapers = async (query) => {
  const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(
    query
  )}`;

  try {
    const response = await axios.get(searchUrl);
    const $ = cheerio.load(response.data);
    const papers = [];

    $(".gs_ri").each((i, elem) => {
      const titleElement = $(elem).find(".gs_rt a");
      const title = titleElement.text();
      const url = titleElement.attr("href") || "";
      const summary = $(elem).find(".gs_rs").text();
      const citations =
        parseInt($(elem).find(".gs_fl").text().match(/\d+/)) || 0;
      const dateMatch = $(elem)
        .find(".gs_a")
        .text()
        .match(/(\d{4})/);
      const date = dateMatch ? dateMatch[0] : null;

      papers.push({
        title,
        url,
        summary,
        citations,
        date,
        score: calculatePaperScore({ citations, date }), // Calculate score
      });
    });

    return papers.sort((a, b) => b.score - a.score);
  } catch (error) {
    console.error("Error fetching academic papers:", error.message);
    throw new Error("Could not fetch academic papers");
  }
};

// Academic papers search route
app.get("/papers", async (req, res) => {
  const searchTerm = req.query.q;

  if (!searchTerm) {
    return res.status(400).send("Please provide a search term");
  }

  try {
    const academicPapers = await getAcademicPapers(searchTerm);
    if (academicPapers.length > 0) {
      res.json({ papers: academicPapers });
    } else {
      res.status(404).json({ error: "No papers found" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch blog posts
const getBlogPosts = async (query, startIndex = 1) => {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
    query + " blog"
  )}&cx=${GOOGLE_CUSTOM_SEARCH_CX}&key=${GOOGLE_CUSTOM_SEARCH_API_KEY}&start=${startIndex}`;

  try {
    const response = await axios.get(url);
    const blogPosts = response.data.items
      .filter(
        (item) =>
          item.link.includes("blog") ||
          item.link.includes(".blog.") ||
          item.link.includes("post")
      )
      .map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        imageUrl: item.pagemap?.cse_image?.[0]?.src,
      }));

    return {
      blogs: blogPosts,
      nextStartIndex: startIndex + 10,
    };
  } catch (error) {
    console.error("Error fetching blog posts:", error.message);
    throw new Error("Could not fetch blog posts");
  }
};

// Blog search route
app.get("/blogs", async (req, res) => {
  const searchTerm = req.query.q;
  const startIndex = parseInt(req.query.start) || 1;

  if (!searchTerm) {
    return res.status(400).send("Please provide a search term");
  }

  try {
    const { blogs, nextStartIndex } = await getBlogPosts(
      searchTerm,
      startIndex
    );
    res.json({ blogs, nextStartIndex });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
