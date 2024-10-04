require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();
const cors = require("cors");
const cheerio = require("cheerio");
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Set up API keys from .env
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GOOGLE_CUSTOM_SEARCH_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
const GOOGLE_CUSTOM_SEARCH_CX = process.env.GOOGLE_CUSTOM_SEARCH_CX;

// Function to calculate the score for YouTube videos
const calculateYoutubeScore = (video) => {
  const views = video.views || 0;
  const likes = video.likes || 0;
  const engagementRate = likes / (views + 1);

  // Define weights for each metric
  const viewsWeight = 0.5;
  const likesWeight = 0.3;
  const engagementWeight = 0.2;

  return (
    views * viewsWeight +
    likes * likesWeight +
    engagementRate * 100 * engagementWeight
  );
};

// Function to calculate the score for articles
const calculateArticleScore = (article) => {
  const relevanceScore = article.snippet.length;
  const domainScore = article.source.includes("reputable-site.com") ? 1 : 0;
  return relevanceScore + domainScore * 10;
};

// Function to calculate the score for academic papers
const calculatePaperScore = (paper) => {
  const citations = paper.citations || 0; // Assume citations are retrieved somehow
  const recency = new Date().getFullYear() - new Date(paper.date).getFullYear(); // Years since publication

  return citations - recency; // Score can be further adjusted based on more metrics
};

// Function to fetch YouTube videos based on a search query
const getYoutubeVideos = async (query, pageToken = "") => {
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=50&q=${query}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;
    const response = await axios.get(url);

    const videoIds = response.data.items
      .map((item) => item.id.videoId)
      .filter((id) => id !== undefined)
      .join(",");

    if (!videoIds) {
      return []; // No video IDs found
    }

    // Fetch statistics for each video
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
    const statsResponse = await axios.get(statsUrl);

    const videoDetails = response.data.items.map((item, index) => {
      const stats = statsResponse.data.items[index]?.statistics || {};
      const video = {
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        thumbnail: item.snippet.thumbnails.medium.url,
        views: parseInt(stats.viewCount, 10) || 0,
        likes: parseInt(stats.likeCount, 10) || 0,
        nextPageToken: response.data.nextPageToken, // Get next page token for pagination
      };

      video.score = calculateYoutubeScore(video); // Calculate the score
      return video;
    });

    // Sort videos by score
    return videoDetails.sort((a, b) => b.score - a.score);
  } catch (error) {
    console.error("Error fetching YouTube data:", error.message);
    throw new Error("Could not fetch YouTube data");
  }
};

// Route to handle YouTube search requests
app.get("/search", async (req, res) => {
  const searchTerm = req.query.q;
  const pageToken = req.query.pageToken; // Get pageToken from query
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

// Function to fetch articles from Google Custom Search API
const fetchGoogleArticles = async (query, startIndex = 1) => {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?q=${query}&key=${GOOGLE_CUSTOM_SEARCH_API_KEY}&cx=${GOOGLE_CUSTOM_SEARCH_CX}&start=${startIndex}`;
    const response = await axios.get(url);

    if (!response.data.items || response.data.items.length === 0) {
      throw new Error("No articles found");
    }

    const articles = response.data.items.map((item) => {
      const article = {
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        source: item.displayLink,
      };

      article.score = calculateArticleScore(article); // Calculate the score
      return article;
    });

    // Sort articles by score
    return {
      articles: articles.sort((a, b) => b.score - a.score),
      nextStartIndex: startIndex + 10,
    };
  } catch (error) {
    console.error(
      "Error fetching articles from Google Custom Search:",
      error.message
    );
    throw new Error("Could not fetch articles from Google Custom Search");
  }
};

// Route to handle article search requests
app.get("/articles", async (req, res) => {
  const searchTerm = req.query.q;
  const startIndex = req.query.start || 1; // Get start index from query
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

// Function to fetch academic papers from Google Scholar
const getAcademicPapers = async (query) => {
  try {
    const searchUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(
      query
    )}`;
    const response = await axios.get(searchUrl);

    const $ = cheerio.load(response.data);
    const papers = [];

    $(".gs_ri").each((i, elem) => {
      const titleElement = $(elem).find(".gs_rt a");
      const title = titleElement.text();
      const url = titleElement.attr("href") || ""; // Default to empty string if no href
      const summary = $(elem).find(".gs_rs").text();

      // Assume we retrieve citations and date somehow
      const citations =
        parseInt($(elem).find(".gs_fl").text().match(/\d+/)) || 0; // Example for citation retrieval
      const date = $(elem)
        .find(".gs_a")
        .text()
        .match(/(\d{4})/); // Year of publication

      papers.push({
        title,
        url,
        summary,
        citations,
        date: date ? date[0] : null, // Extract year from text
        score: calculatePaperScore({ citations, date }), // Calculate score
      });
    });

    // Sort papers by score
    return papers.sort((a, b) => b.score - a.score);
  } catch (error) {
    console.error(
      "Error fetching academic papers from Google Scholar:",
      error.message
    );
    throw new Error("Could not fetch academic papers");
  }
};

// Route to handle academic papers search requests
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

// Function to fetch blog posts from Google Custom Search API
const getBlogPosts = async (query, startIndex = 1) => {
  try {
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(
      query + " blog"
    )}&cx=${GOOGLE_CUSTOM_SEARCH_CX}&key=${GOOGLE_CUSTOM_SEARCH_API_KEY}&start=${startIndex}`;
    const response = await axios.get(url);

    // Return only entries that are more likely to be blogs
    const blogPosts = response.data.items
      .filter(
        (item) =>
          item.link.includes("blog") ||
          item.link.includes(".blog.") ||
          item.link.includes("post") ||
          (item.snippet && item.snippet.includes("blog"))
      )
      .map((item) => {
        const blog = {
          title: item.title,
          url: item.link,
          snippet: item.snippet,

          imageUrl: item.pagemap?.cse_image?.[0]?.src,
        };
        return blog;
      });

    // Sort blog posts by score
    return {
      blogs: blogPosts,
      nextStartIndex: startIndex + 10,
    };
  } catch (error) {
    console.error("Error fetching blog posts:", error.message);
    throw new Error("Could not fetch blog posts");
  }
};

// Route to handle blog search requests
app.get("/blogs", async (req, res) => {
  const searchTerm = req.query.q;
  const startIndex = req.query.start || 1; // Get start index from query
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
